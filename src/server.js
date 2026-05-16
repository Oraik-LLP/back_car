import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';
import {
  consumeDiagnosticQuota,
  getDiagnosticQuotaStatus,
  initializeQuotaStore,
  resetDiagnosticQuota,
} from './quota_store.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const diagnosisModel =
  process.env.GEMINI_DIAGNOSIS_MODEL || 'gemini-flash-latest';
const liveHttpModel = 
  process.env.GEMINI_LIVE_HTTP_MODEL || 'gemini-flash-lite-latest';
const liveModel =
  process.env.GEMINI_LIVE_MODEL || 'gemini-flash-lite-latest';
const maxJsonMb = Number(process.env.MAX_JSON_MB || 30);
const maxJsonBytes = maxJsonMb * 1024 * 1024;
const requestQueueTimeoutMs = Number(process.env.REQUEST_QUEUE_TIMEOUT_MS || 12000);
const largeRequestBytes = Number(process.env.LARGE_REQUEST_BYTES || 8 * 1024 * 1024);
const upstreamTimeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 65000);
const runningInProduction = process.env.NODE_ENV === 'production';
const aiClient = createAiClient();

app.use(cors());
app.use((req, res, next) => {
  const lengthHeader = req.headers['content-length'];
  const declaredBytes = Number(lengthHeader || 0);
  req.requestSizeBytes = Number.isFinite(declaredBytes) ? declaredBytes : 0;
  if (req.requestSizeBytes > maxJsonBytes) {
    res.status(413).json({
      message: `Request body is too large. Max supported size is ${maxJsonMb} MB.`,
      error_code: 'payload_too_large',
      retryable: false,
    });
    return;
  }
  next();
});
app.use(express.json({ limit: `${maxJsonMb}mb` }));

app.use((req, res, next) => {
  req.requestId = Math.random().toString(36).slice(2, 10);
  req.requestStartedAt = Date.now();
  const plan = resolveRequestPlan(req);
  req.requestPlan = plan;
  res.on('finish', () => {
    const durationMs = Date.now() - req.requestStartedAt;
    console.log(
      `[${new Date().toISOString()}] ${req.requestId} ${req.method} ${req.path} ` +
        `${res.statusCode} ${durationMs}ms plan=${plan} size=${req.requestSizeBytes}`,
    );
  });
  next();
});

app.use((req, res, next) => {
  let released = false;
  const releaseIfNeeded = () => {
    if (released) return;
    released = true;
    try {
      req.releaseGate?.();
    } catch (_) {}
  };
  res.on('finish', releaseIfNeeded);
  res.on('close', releaseIfNeeded);
  next();
});

const diagnosisGate = createRequestGate({
  name: 'diagnosis',
  maxConcurrent: Number(process.env.DIAGNOSIS_MAX_CONCURRENT || 4),
  reservedForPro: Number(process.env.DIAGNOSIS_RESERVED_FOR_PRO || 1),
  maxQueue: Number(process.env.DIAGNOSIS_MAX_QUEUE || 12),
  maxLargeConcurrent: Number(process.env.DIAGNOSIS_MAX_LARGE_CONCURRENT || 1),
});

const liveGate = createRequestGate({
  name: 'live',
  maxConcurrent: Number(process.env.LIVE_MAX_CONCURRENT || 6),
  reservedForPro: Number(process.env.LIVE_RESERVED_FOR_PRO || 2),
  maxQueue: Number(process.env.LIVE_MAX_QUEUE || 16),
  maxLargeConcurrent: Number(process.env.LIVE_MAX_LARGE_CONCURRENT || 2),
});

function createAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing GEMINI_API_KEY');
    error.statusCode = 500;
    error.errorCode = 'missing_api_key';
    throw error;
  }
  return new GoogleGenAI({ apiKey });
}

function resolveRequestPlan(req) {
  const rawPlan = String(req.headers['x-fixease-plan'] || 'free').toLowerCase();
  return rawPlan === 'pro' || rawPlan === 'emergencypass' || rawPlan === 'emergency_pass'
    ? 'pro'
    : 'free';
}

function isLargeRequest(req) {
  return (req.requestSizeBytes || 0) >= largeRequestBytes;
}

function createRequestGate({
  name,
  maxConcurrent,
  reservedForPro,
  maxQueue,
  maxLargeConcurrent,
}) {
  let active = 0;
  let activeLarge = 0;
  const queue = [];

  const canRun = (ticket) => {
    if (active >= maxConcurrent) return false;
    if (ticket.isLarge && activeLarge >= maxLargeConcurrent) return false;
    if (ticket.plan !== 'pro' && active >= Math.max(0, maxConcurrent - reservedForPro)) {
      return false;
    }
    return true;
  };

  const acquire = (ticket) => {
    active += 1;
    if (ticket.isLarge) {
      activeLarge += 1;
    }
  };

  const release = (ticket) => {
    active = Math.max(0, active - 1);
    if (ticket.isLarge) {
      activeLarge = Math.max(0, activeLarge - 1);
    }
    drain();
  };

  const drain = () => {
    for (let index = 0; index < queue.length; index += 1) {
      const ticket = queue[index];
      if (!canRun(ticket)) {
        continue;
      }
      queue.splice(index, 1);
      clearTimeout(ticket.timeout);
      acquire(ticket);
      ticket.resolve(() => release(ticket));
      index -= 1;
    }
  };

  return async function gate(req, _res, next) {
    const ticket = {
      plan: req.requestPlan || resolveRequestPlan(req),
      isLarge: isLargeRequest(req),
      resolve: null,
      timeout: null,
    };

    if (canRun(ticket)) {
      acquire(ticket);
      req.releaseGate = () => release(ticket);
      next();
      return;
    }

    if (queue.length >= maxQueue) {
      next(createBusyError(`${name}_queue_full`));
      return;
    }

    try {
      req.releaseGate = await new Promise((resolve, reject) => {
        ticket.resolve = resolve;
        ticket.timeout = setTimeout(() => {
          const index = queue.indexOf(ticket);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          reject(createBusyError(`${name}_queue_timeout`));
        }, requestQueueTimeoutMs);
        queue.push(ticket);
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

function createBusyError(errorCode) {
  const error = new Error(
    'FixEase is handling a burst of requests right now. Please retry in a moment.',
  );
  error.statusCode = 503;
  error.errorCode = errorCode;
  error.retryable = true;
  return error;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    diagnosis_model: diagnosisModel,
    live_model: liveModel,
  });
});

app.get('/api/quota/diagnostics/status', async (req, res) => {
  try {
    const quota = await getDiagnosticQuotaStatus({
      deviceId: resolveDeviceId(req),
      plan: req.requestPlan,
      liveSessionId: resolveLiveSessionId(req),
    });
    res.json({
      quota: serializeQuotaStatus(quota),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/quota/diagnostics/reset', async (req, res) => {
  try {
    if (!canResetQuotaForTesting(req)) {
      res.status(403).json({
        message: 'Quota reset is disabled outside testing builds.',
        error_code: 'testing_reset_disabled',
        retryable: false,
      });
      return;
    }

    const quota = await resetDiagnosticQuota({
      deviceId: resolveDeviceId(req),
    });
    res.json({
      quota: serializeQuotaStatus(quota),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/diagnose/symptoms', diagnosisGate, async (req, res) => {
  try {
    await ensureDiagnosticQuotaAllowed(req);
    const { vehicle, symptoms = [], severity = 'medium', description } = req.body ?? {};
    const prompt = buildSymptomPrompt({ vehicle, symptoms, severity, description });
    const text = await generateText({
      model: diagnosisModel,
      prompt,
      responseMimeType: 'application/json',
    });
    const normalized = normalizeDiagnosisResponse(text, 'gemini');
    await consumeDiagnosticQuotaForRequest(req);
    res.json(normalized);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/diagnose/photos', diagnosisGate, async (req, res) => {
  try {
    await ensureDiagnosticQuotaAllowed(req);
    const { vehicle, images = [], description, obd_context } = req.body ?? {};
    const contents = [
      {
        role: 'user',
        parts: [
          { text: buildPhotoPrompt({ vehicle, description, obdContext: obd_context }) },
          ...images
            .filter((image) => image?.data && image?.mime_type)
            .slice(0, 8)
            .map((image) => ({
              inlineData: {
                mimeType: image.mime_type,
                data: image.data,
              },
            })),
        ],
      },
    ];
    const text = await generateContent({
      model: diagnosisModel,
      contents,
      responseMimeType: 'application/json',
    });
    const normalized = normalizeDiagnosisResponse(text, 'gemini');
    await consumeDiagnosticQuotaForRequest(req);
    res.json(normalized);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/diagnose/invoice-audit', diagnosisGate, async (req, res) => {
  try {
    const { vehicle, documents = [], purpose } = req.body ?? {};
    const contents = [
      {
        role: 'user',
        parts: [
          { text: buildInvoiceAuditPrompt({ vehicle, purpose }) },
          ...documents
            .filter((document) => document?.data && document?.mime_type)
            .slice(0, 4)
            .map((document) => ({
              inlineData: {
                mimeType: document.mime_type,
                data: document.data,
              },
            })),
        ],
      },
    ];
    const text = await generateContent({
      model: diagnosisModel,
      contents,
      responseMimeType: 'application/json',
    });
    const normalized = normalizeInvoiceAuditResponse(text, 'gemini');
    res.json(normalized);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/diagnose/obd-pro', diagnosisGate, async (req, res) => {
  try {
    const {
      vehicle,
      mode = 'idle',
      is_partial = false,
      completion_reason = 'completed',
      target_duration_seconds = 0,
      captured_duration_seconds = 0,
      static_snapshot = {},
      processed_scan = {},
    } = req.body ?? {};
    const prompt = buildObdProPrompt({
      vehicle,
      mode,
      isPartial: is_partial,
      completionReason: completion_reason,
      targetDurationSeconds: target_duration_seconds,
      capturedDurationSeconds: captured_duration_seconds,
      staticSnapshot: static_snapshot,
      processedScan: processed_scan,
    });
    const text = await generateText({
      model: diagnosisModel,
      prompt,
      responseMimeType: 'application/json',
    });
    const normalized = normalizeDiagnosisResponse(text, 'gemini');
    res.json(normalized);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/conversations/respond', liveGate, async (req, res) => {
  try {
    const {
      vehicle,
      session_context = {},
      history = [],
      message = '',
      audio,
      attachment,
      image,
    } = req.body ?? {};

    const parts = [
      {
        text: buildConversationPrompt({
          vehicle,
          sessionContext: session_context,
          history,
          message,
          hasAudio: Boolean(audio?.data),
          hasAttachment: Boolean(attachment?.data || image?.data),
        }),
      },
    ];

    if (audio?.data && audio?.mimeType) {
      parts.push({
        inlineData: {
          mimeType: audio.mimeType,
          data: audio.data,
        },
      });
    }

    const media = attachment?.data ? attachment : image;
    if (media?.data && media?.mime_type) {
      parts.push({
        inlineData: {
          mimeType: media.mime_type,
          data: media.data,
        },
      });
    }

    const text = await generateContent({
      model: liveHttpModel,
      contents: [{ role: 'user', parts }],
    });

    res.json({
      text,
      provider: 'gemini-flash-lite',
      is_fallback: false,
      error_code: null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/live/text', liveGate, async (req, res) => {
  try {
    await ensureDiagnosticQuotaAllowed(req);
    const { vehicle, history = [], message = '', obd_context } = req.body ?? {};
    const prompt = buildLiveTextPrompt({
      vehicle,
      history,
      message,
      obdContext: obd_context,
    });
    const text = await generateText({ model: liveHttpModel, prompt });
    await consumeDiagnosticQuotaForRequest(req);
    res.json({
      text,
      provider: 'gemini-live',
      is_fallback: false,
      error_code: null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/live/frame', liveGate, async (req, res) => {
  try {
    await ensureDiagnosticQuotaAllowed(req);
    const { vehicle, history = [], message = '', image, obd_context } = req.body ?? {};
    const parts = [
      {
        text: buildLiveFramePrompt({
          vehicle,
          history,
          message,
          obdContext: obd_context,
        }),
      },
    ];
    if (image?.data && image?.mime_type) {
      parts.push({
        inlineData: {
          mimeType: image.mime_type,
          data: image.data,
        },
      });
    }
    const text = await generateContent({
      model: liveHttpModel,
      contents: [{ role: 'user', parts }],
    });
    await consumeDiagnosticQuotaForRequest(req);
    res.json({
      text,
      provider: 'gemini-live',
      is_fallback: false,
      error_code: null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ── Turn-based voice endpoint ────────────────────────────────────────────────
// Accepts: audio (base64 WAV), optional image (base64 JPEG), conversation history
// Returns: text response from Gemini
app.post('/api/live/voice', liveGate, async (req, res) => {
  try {
    await ensureDiagnosticQuotaAllowed(req);
    const { vehicle, history = [], audio, image, obd_context } = req.body ?? {};

    const systemPrompt = `You are FixEase Live, a friendly expert automotive diagnostic assistant having a real-time voice conversation.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

${buildObdContextAppendix(obd_context)}

Respond naturally in 2-4 sentences. Be specific and practical. If the user sent a photo, analyze it carefully. Ask follow-up questions when needed.`;

    const parts = [{ text: systemPrompt }];

    // Add audio as inline data if provided
    if (audio?.data && audio?.mimeType) {
      parts.push({
        inlineData: {
          mimeType: audio.mimeType,
          data: audio.data,
        },
      });
    }

    // Add image as inline data if provided
    if (image?.data && image?.mimeType) {
      parts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data,
        },
      });
    }

    const text = await generateContent({
      model: liveHttpModel,
      contents: [{ role: 'user', parts }],
    });
    await consumeDiagnosticQuotaForRequest(req);

    res.json({
      text,
      provider: 'gemini-voice',
      is_fallback: false,
      error_code: null,
    });
  } catch (error) {
    sendError(res, error);
  }
});

async function generateText({ model, prompt, responseMimeType, maxOutputTokens }) {
  return generateContent({
    model,
    responseMimeType,
    maxOutputTokens,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  });
}

async function generateContent({ model, contents, responseMimeType, maxOutputTokens }) {
  return withTimeout(
    (async () => {
      const response = await aiClient.models.generateContentStream({
        model,
        contents,
        config: {
          ...(responseMimeType ? { responseMimeType } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        },
      });

      let text = '';
      for await (const chunk of response) {
        if (chunk.text) {
          text += chunk.text;
        }
      }
      return text.trim();
    })(),
    upstreamTimeoutMs,
    `Gemini ${model} request timed out after ${upstreamTimeoutMs}ms`,
  );
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutHandle;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(message);
          error.statusCode = 504;
          error.errorCode = 'upstream_timeout';
          error.retryable = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function normalizeDiagnosisResponse(rawText, provider) {
  const cleaned = stripCodeFences(rawText);
  const parsed = JSON.parse(cleaned);
  return {
    summary: parsed.summary || '',
    health_score: Number(parsed.health_score ?? 5),
    confidence: Number(parsed.confidence ?? 0.5),
    possible_causes: Array.isArray(parsed.possible_causes)
      ? parsed.possible_causes
      : [],
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : [],
    sub_scores:
      parsed.sub_scores && typeof parsed.sub_scores === 'object'
        ? parsed.sub_scores
        : {},
    urgency_note: parsed.urgency_note || null,
    mechanic_script: parsed.mechanic_script || null,
    suggested_question: parsed.suggested_question || null,
    provider,
    is_fallback: false,
    error_code: null,
  };
}

function normalizeInvoiceAuditResponse(rawText, provider) {
  const cleaned = stripCodeFences(rawText);
  const parsed = JSON.parse(cleaned);
  return {
    summary: parsed.summary || '',
    health_score: Number(parsed.health_score ?? 5),
    confidence: Number(parsed.confidence ?? 0.5),
    possible_causes: Array.isArray(parsed.possible_causes)
      ? parsed.possible_causes
      : [],
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations
      : [],
    sub_scores:
      parsed.sub_scores && typeof parsed.sub_scores === 'object'
        ? parsed.sub_scores
        : {},
    urgency_note: parsed.urgency_note || null,
    mechanic_script: parsed.mechanic_script || null,
    suggested_question: parsed.suggested_question || null,
    document_type: parsed.document_type || null,
    verdict: parsed.verdict || null,
    top_flags: Array.isArray(parsed.top_flags) ? parsed.top_flags : [],
    line_item_audit: Array.isArray(parsed.line_item_audit)
      ? parsed.line_item_audit.map((item) => ({
          item: item?.item || '',
          charge: item?.charge || '',
          assessment: item?.assessment || '',
          reason: item?.reason || '',
          confidence: item?.confidence || 'Low',
        }))
      : [],
    padding_patterns_detected: Array.isArray(parsed.padding_patterns_detected)
      ? parsed.padding_patterns_detected
      : [],
    questions_to_ask: Array.isArray(parsed.questions_to_ask)
      ? parsed.questions_to_ask
      : [],
    negotiation_script: parsed.negotiation_script || null,
    limitations: parsed.limitations || null,
    partial_audit:
      parsed.partial_audit === true || parsed.partial_audit === 'true',
    provider,
    is_fallback: false,
    error_code: null,
  };
}

function stripCodeFences(text) {
  let cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return cleaned.substring(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function buildSymptomPrompt({ vehicle, symptoms, severity, description }) {
  return `${buildDiagnosticSystemPrompt({
    vehicle,
    mode: 'symptom',
    subjectLabel: 'reported symptoms',
    schemaJson: `{
  "summary": "One short empathy sentence first, then 1-2 factual technical sentences.",
  "health_score": 0,
  "confidence": 0.0,
  "possible_causes": ["cause1"],
  "recommendations": ["action1"],
  "sub_scores": {"Engine": 0, "Brakes": 0, "Transmission": 0, "Electrical": 0, "Suspension": 0},
  "urgency_note": "string or null",
  "mechanic_script": "Dense mechanic-facing handoff with likely OBD2 codes, pinpoint test steps, expected tolerances, voltages, pressures, free-play, runout, pad thickness, or other exact checks when relevant.",
  "suggested_question": "string or null"
}`,
  })}

REPORTED SYMPTOMS:
${symptoms.map((item) => `- ${item}`).join('\n')}

SEVERITY: ${severity}
${description ? `ADDITIONAL NOTES: ${description}` : 'ADDITIONAL NOTES: None'}

DIAGNOSTIC FOCUS:
- Explain the likely fault chain based on the symptom combination.
- If some systems appear unaffected, you may briefly say so inside the summary to build trust, but do not downplay urgent faults.
- Keep the mechanic_script authoritative and workshop-grade. Reference likely DTC families, scan-tool checks, manufacturer-spec comparisons, backlash/play, fluid condition, wear limits in mm, and electrical ranges when appropriate.`;
}

function buildPhotoPrompt({ vehicle, description, obdContext }) {
  return `${buildDiagnosticSystemPrompt({
    vehicle,
    mode: 'photo',
    subjectLabel: 'attached vehicle photos',
    schemaJson: `{
  "summary": "One short empathy sentence first, then 1-2 factual visual findings sentences.",
  "health_score": 0,
  "confidence": 0.0,
  "possible_causes": ["issue1"],
  "recommendations": ["action1"],
  "sub_scores": {"Body": 0, "Tires": 0, "Engine Bay": 0, "Fluids": 0, "Interior": 0},
  "urgency_note": "string or null",
  "mechanic_script": "Dense mechanic-facing handoff with visual fault hypotheses, inspection targets, tolerance checks, leak-source confirmation steps, and probable measurement points.",
  "suggested_question": "string or null"
}`,
  })}

USER DESCRIPTION: ${description || 'None'}

${buildObdContextAppendix(obdContext)}

VISUAL INSPECTION CHECKLIST:
- visible damage
- fluid leaks
- tire condition
- rust or corrosion
- worn belts, hoses, or connectors
- dashboard warning lights
- any other anomalies

DIAGNOSTIC FOCUS:
- Base findings only on what is visible plus the user description.
- State uncertainty honestly if the image quality, angle, or coverage is limited.
- Keep the mechanic_script technical and inspection-oriented, with likely measurements, allowable ranges, and exact next checks where appropriate.`;
}

function buildObdProPrompt({
  vehicle,
  mode,
  isPartial,
  completionReason,
  targetDurationSeconds,
  capturedDurationSeconds,
  staticSnapshot,
  processedScan,
}) {
  return `${buildDiagnosticSystemPrompt({
    vehicle,
    mode: `obd_${mode}`,
    subjectLabel: 'processed OBD2 telemetry and static ECU data',
    schemaJson: `{
  "summary": "One short empathy sentence first, then 1-2 factual technical sentences.",
  "health_score": 0,
  "confidence": 0.0,
  "possible_causes": ["cause1"],
  "recommendations": ["action1"],
  "sub_scores": {"Combustion Stability": 0, "Air/Fuel Balance": 0, "Load Response": 0, "Electrical Health": 0, "Thermal Health": 0},
  "urgency_note": "string or null",
  "mechanic_script": "Dense mechanic-facing handoff with likely root-cause branches, expected live-data relationships, and next verification checks.",
  "suggested_question": "string or null"
}`,
  })}

SCAN MODE: ${mode}
SCAN COMPLETENESS: ${isPartial ? 'Partial' : 'Full'}
COMPLETION REASON: ${completionReason}
TARGET DURATION SECONDS: ${targetDurationSeconds}
CAPTURED DURATION SECONDS: ${capturedDurationSeconds}

STATIC SNAPSHOT JSON:
${JSON.stringify(staticSnapshot, null, 2)}

PROCESSED SCAN JSON:
${JSON.stringify(processedScan, null, 2)}

OBD ANALYSIS RULES:
- Base conclusions on the processed telemetry plus the static snapshot only.
- Treat partial scans as lower confidence and say so clearly when relevant.
- Infer likely mechanical health, fueling balance, thermal behavior, and load behavior from the recorded relationships.
- If no severe defect is evident, say what still appears healthy.
- Keep the mechanic_script workshop-grade and tied to likely live-data verification steps.`;
}

function buildInvoiceAuditPrompt({ vehicle, purpose }) {
  return `You are an automotive invoice auditor specializing in repair-bill fraud signals, upsells, redundant labor, and pricing anomalies.

Your task is to review an uploaded mechanic invoice, dealership service bill, workshop estimate, repair quote, or mixed repair document. Extract the bill contents and audit whether the charges appear fair, inflated, redundant, vague, or unnecessary.

VEHICLE:
- ${vehicle?.display_name || 'Unknown vehicle'}
- Fuel: ${vehicle?.fuel_label || 'Unknown'}
- Mileage: ${vehicle?.mileage_km || 0} km
${purpose ? `VISIT PURPOSE: ${purpose}` : 'VISIT PURPOSE: Not provided'}

Primary goals:
1. Identify suspicious or padded charges
2. Detect overlapping or duplicate labor
3. Flag common upsell patterns
4. Highlight vague fees or poor justification
5. Explain findings in simple consumer language

Pay special attention to:
- redundant labor charges across related operations
- inflated labor hours compared with typical repair workflows
- dealership markup ("dealership tax")
- unnecessary fluid flushes, injector cleaning, AC sanitizing, throttle cleaning, and similar add-ons
- diagnostic fee billed twice or hidden inside labor
- whole assembly replacement when a smaller repair may have been possible
- premium part pricing without clear justification
- vague charges such as "misc," "service package," "shop supplies," or disposal fees
- urgency claims that are not supported by the invoice details
- stacked "while we're in there" upsells

If exact year/make/model/engine/trim/region is missing, do not pretend precision. State clearly when a benchmark is approximate. If labor benchmarks are approximate, infer based on common repair standards and invoice overlap logic. If extracted invoice text is incomplete, explicitly say the audit may be partial.

Do not give legal conclusions. Do not claim fraud as fact unless directly evident. Frame findings as:
- likely reasonable
- possibly inflated
- questionable
- likely unnecessary
- worth challenging

Return ONLY a JSON object with this exact structure:
{
  "summary": "2-4 sentence plain-English summary",
  "health_score": 0.0,
  "confidence": 0.0,
  "possible_causes": ["Short list of the biggest concerns phrased simply"],
  "recommendations": ["Plain-language next steps for the customer"],
  "sub_scores": {
    "Labor Fairness": 0,
    "Parts Pricing": 0,
    "Fee Clarity": 0,
    "Justification": 0,
    "Upsell Risk": 0
  },
  "urgency_note": "string or null",
  "mechanic_script": "Dense auditor-facing note with likely labor-overlap checkpoints, benchmark caveats, and the most challengeable technical line items.",
  "document_type": "Invoice | Quote | Estimate | Mixed | Unknown",
  "verdict": "Fair | Mixed | Suspicious | Likely Overpriced",
  "top_flags": ["Biggest concerns only"],
  "line_item_audit": [
    {
      "item": "line item name",
      "charge": "amount or quoted amount",
      "assessment": "likely reasonable | possibly inflated | questionable | likely unnecessary | worth challenging",
      "reason": "brief consumer-friendly explanation",
      "confidence": "Low | Medium | High"
    }
  ],
  "padding_patterns_detected": [
    "Duplicate labor | Labor overlap | Vague fee | Unnecessary flush/service | Diagnostic double-charge | Assembly replacement | Excessive parts markup | Weak justification | Dealer markup"
  ],
  "questions_to_ask": ["4-8 sharp follow-up questions"],
  "suggested_question": "string or null",
  "negotiation_script": "Short script the customer can use to challenge the bill politely.",
  "limitations": "Briefly mention missing details that reduce confidence.",
  "partial_audit": true
}`;
}

function buildDiagnosticSystemPrompt({ vehicle, mode, subjectLabel, schemaJson }) {
  return `You are FixEase, a senior automotive diagnostic AI producing a structured report for a stressed everyday driver.

MISSION:
- Analyze the ${subjectLabel}.
- Sound calm, factual, confident, and reassuring.
- Return strictly valid JSON only.
- Never add markdown, code fences, commentary, or extra keys.

USER CONTEXT:
- The driver may be stranded, anxious, or worried about an expensive repair bill.
- The summary must begin with exactly one short human-sounding empathy check sentence.
- That empathy sentence must immediately transition into the technical summary in the same "summary" field.
- The empathy sentence should feel grounded, not cheesy. It can acknowledge stress or briefly note what still appears healthy before naming the actual issue.

VEHICLE:
- ${vehicle?.display_name || 'Unknown vehicle'}
- Fuel: ${vehicle?.fuel_label || 'Unknown'}
- Mileage: ${vehicle?.mileage_km || 0} km
${vehicle?.last_service_date ? `- Last service: ${vehicle.last_service_date}` : '- Last service: Unknown'}
- Diagnostic mode: ${mode}

STRICT OUTPUT CONTRACT:
- Return one JSON object only.
- Use this exact schema and key order:
${schemaJson}
- Do not omit required keys.
- Use null only where the schema explicitly allows null.
- "summary" must be 2-3 sentences total. Sentence 1 is the empathy check. Remaining sentence(s) are the actual technical summary.
- "possible_causes" and "recommendations" must be concise arrays, not paragraphs.
- "mechanic_script" must stay hidden-user style: dense, technical, and authoritative.

SCORING RULES:
- health_score must be an integer from 0 to 100 where 100 = very healthy and 0 = unsafe / failed.
- Every sub_score must be 0 to 100 where higher = healthier.
- confidence must be a decimal from 0.0 to 1.0.
- Do not use 0 to 10 scoring anywhere.
- If the condition is urgent, dangerous, or likely to worsen quickly, scores must move lower accordingly.

MECHANIC SCRIPT RULES:
- Write for a competent technician, not the driver.
- Include likely subsystem fault paths, probable DTC families or exact DTCs when justified, and test priorities.
- Mention exact manufacturer-spec style checks when relevant: voltages, resistance ranges, pressure ranges, temperature deltas, endplay, rotor runout, pad/shoe thickness, tread depth, fluid contamination indicators, free play, or torque/tolerance comparisons.
- If exact OEM spec is unknown, say "verify against OEM spec" rather than inventing fake certainty.
- Use confident workshop language and concise authoritative jargon.

FAILURE RULES:
- If evidence is incomplete, say so inside the JSON fields instead of breaking schema.
- If multiple faults are plausible, prioritize the most safety-critical or likely one first.`;
}

function buildConversationPrompt({
  vehicle,
  sessionContext,
  history,
  message,
  hasAudio,
  hasAttachment,
}) {
  const diagnosisJson = sessionContext?.diagnosis_json
    ? JSON.stringify(sessionContext.diagnosis_json, null, 2)
    : 'None';

  return `You are FixEase Follow-up, a practical automotive assistant continuing an existing support conversation.

MODEL RULES:
- This is a continuation chat, not a fresh one-shot diagnosis.
- Reuse the prior diagnosis context when it helps.
- Answer directly, practically, and in plain English.
- Ask a concise follow-up question if clarification is needed.
- Do not repeat the entire old diagnosis unless the user asks.
- If the prior session was an invoice audit, stay focused on bill fairness, questionable charges, evidence, and what to ask the shop.
- If the user attached new media, analyze it as part of the conversation.
- If the user sent audio, respond with text only.

VEHICLE:
- ${vehicle?.display_name || sessionContext?.vehicle_name || 'Unknown vehicle'}
- Fuel: ${vehicle?.fuel_label || 'Unknown'}
- Mileage: ${vehicle?.mileage_km || 0} km

SESSION CONTEXT:
- Session type: ${sessionContext?.session_type || 'unknown'}
- Session title: ${sessionContext?.session_title || 'Unknown'}
- Created at: ${sessionContext?.created_at || 'Unknown'}
- Severity: ${sessionContext?.severity || 'Unknown'}
- Description: ${sessionContext?.description || 'None'}
- Symptoms: ${Array.isArray(sessionContext?.symptoms) && sessionContext.symptoms.length
    ? sessionContext.symptoms.join(', ')
    : 'None'}
- Previous summary: ${sessionContext?.diagnosis_summary || 'None'}

STRUCTURED DIAGNOSIS CONTEXT:
${diagnosisJson}

CONVERSATION SO FAR:
${history.length
    ? history.map((item) => `${item.role?.toUpperCase?.() || 'USER'} (${item.source || 'text'}): ${item.text || ''}`).join('\n')
    : 'No previous messages in this saved thread.'}

NEW TURN:
- Text message: ${message || 'None'}
- Audio attached: ${hasAudio ? 'Yes' : 'No'}
- Additional media attached: ${hasAttachment ? 'Yes' : 'No'}

Respond in 2-6 sentences. Keep it helpful and conversational.`;
}

function buildLiveTextPrompt({ vehicle, history, message, obdContext }) {
  return `You are FixEase Live, a real-time automotive diagnostic assistant.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

${buildObdContextAppendix(obdContext)}

USER: ${message}

Respond in 2-4 sentences. Be specific, practical, and ask for clarification if needed.`;
}

function buildLiveFramePrompt({ vehicle, history, message, obdContext }) {
  return `You are FixEase Live, a real-time automotive diagnostic assistant reviewing a fresh camera frame.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

${buildObdContextAppendix(obdContext)}

The user captured a frame and said: "${message}"

Analyze the image and respond in 2-4 sentences. Name likely issues clearly. If needed, ask for another angle or a closer shot.`;
}

function buildObdContextAppendix(obdContext) {
  if (!obdContext || typeof obdContext !== 'object' || Object.keys(obdContext).length === 0) {
    return 'OBD CONTEXT: None';
  }
  return `LATEST OBD PRO CONTEXT:
${JSON.stringify(obdContext, null, 2)}

Use this only as supplemental context. Do not claim certainty beyond what the OBD data supports.`;
}

function resolveDeviceId(req) {
  return String(req.headers['x-fixease-device-id'] || '').trim();
}

function resolveLiveSessionId(req) {
  return String(req.headers['x-fixease-live-session-id'] || '').trim();
}

function canResetQuotaForTesting(req) {
  const requested =
    String(req.headers['x-fixease-testing-reset'] || '').toLowerCase().trim() ===
    'true';
  if (!requested) {
    return false;
  }
  return !runningInProduction || process.env.ALLOW_TEST_QUOTA_RESET === 'true';
}

async function ensureDiagnosticQuotaAllowed(req) {
  const quota = await getDiagnosticQuotaStatus({
    deviceId: resolveDeviceId(req),
    plan: req.requestPlan,
    liveSessionId: resolveLiveSessionId(req),
  });
  if (!quota.allowed) {
    const error = new Error(
      'Your free FixEase diagnostics are used up for now. Upgrade to keep scanning.',
    );
    error.statusCode = 402;
    error.errorCode = 'free_quota_exhausted';
    error.retryable = false;
    throw error;
  }
  return quota;
}

async function consumeDiagnosticQuotaForRequest(req) {
  return consumeDiagnosticQuota({
    deviceId: resolveDeviceId(req),
    plan: req.requestPlan,
    liveSessionId: resolveLiveSessionId(req),
  });
}

function serializeQuotaStatus(quota) {
  return {
    allowed: quota.allowed,
    unlimited: quota.unlimited,
    limit: quota.limit,
    remaining: quota.remaining,
    used: quota.used,
    window_days: quota.windowDays,
    reset_at: quota.resetAt instanceof Date ? quota.resetAt.toISOString() : null,
    session_consumed: quota.sessionConsumed,
  };
}

function sendError(res, error) {
  const normalized = normalizeError(error);
  res.status(normalized.statusCode).json({
    message: normalized.message,
    error_code: normalized.errorCode,
    retryable: normalized.retryable,
  });
}

function normalizeError(error) {
  const message = String(error?.message || 'AI request failed');
  const lower = message.toLowerCase();
  if (error?.errorCode === 'device_id_missing') {
    return {
      statusCode: 400,
      message,
      errorCode: error.errorCode,
      retryable: false,
    };
  }
  if (
    error?.errorCode === 'free_quota_exhausted' ||
    error?.errorCode === 'quota_verification_unavailable'
  ) {
    return {
      statusCode: error?.statusCode || 503,
      message,
      errorCode: error?.errorCode,
      retryable: error?.retryable ?? true,
    };
  }
  if (error?.statusCode === 503 || lower.includes('queue_full') || lower.includes('queue_timeout')) {
    return {
      statusCode: 503,
      message:
        'FixEase is handling a burst of requests right now. Please retry in a moment.',
      errorCode: error?.errorCode || 'server_busy',
      retryable: true,
    };
  }
  if (error?.statusCode === 504 || lower.includes('timed out')) {
    return {
      statusCode: 504,
      message: 'The AI provider took too long to respond. Please retry shortly.',
      errorCode: error?.errorCode || 'upstream_timeout',
      retryable: true,
    };
  }
  if (lower.includes('quota') || lower.includes('429') || lower.includes('resource_exhausted')) {
    return {
      statusCode: 429,
      message: 'Gemini quota exceeded. Check billing or wait before retrying.',
      errorCode: 'quota_exceeded',
      retryable: true,
    };
  }
  if (lower.includes('api key') || lower.includes('permission') || lower.includes('401') || lower.includes('403')) {
    return {
      statusCode: 502,
      message: 'Gemini authentication failed. Check backend credentials.',
      errorCode: 'auth_failed',
      retryable: false,
    };
  }
  return {
    statusCode: error?.statusCode || 500,
    message,
    errorCode: error?.errorCode || 'ai_request_failed',
    retryable: true,
  };
}

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws, req) => {
  if (req.url !== '/api/live/stream') {
    ws.close();
    return;
  }

  console.log(`[${new Date().toISOString()}] WS /api/live/stream connected`);

  try {
    const session = await aiClient.live.connect({
      model: liveModel,
      config: {
        responseModalities: ["AUDIO"],
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      },
      callbacks: {
        onmessage: (msg) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        },
        onerror: (e) => console.error("Session Error:", e),
        onclose: () => ws.close(),
      }
    });

    // ── Audio buffer: batch mic chunks every 80ms to avoid flooding Gemini ─────
    let audioBuffer = [];
    let audioFlushTimer = null;

    function flushAudio() {
      if (audioBuffer.length === 0) return;
      const chunks = audioBuffer.splice(0);
      // Concatenate all base64 audio chunks from this interval
      const combined = Buffer.concat(chunks.map(b => Buffer.from(b, 'base64')));
      try {
        session.sendRealtimeInput({
          audio: { data: combined.toString('base64'), mimeType: 'audio/pcm;rate=16000' }
        });
      } catch (err) {
        console.error('sendRealtimeInput audio error:', err.message);
      }
    }

    audioFlushTimer = setInterval(flushAudio, 80);

    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.realtimeInput) {
          const ri = payload.realtimeInput;
          if (ri.audio?.data) {
            // Buffer audio — flush every 80ms
            audioBuffer.push(ri.audio.data);
          } else if (ri.text) {
            try { session.sendRealtimeInput({ text: ri.text }); } catch (e) { console.error('text send err:', e.message); }
          } else if (ri.video) {
            try { session.sendRealtimeInput({ video: ri.video }); } catch (e) { console.error('video send err:', e.message); }
          }
        } else if (payload.clientContent) {
          try { session.sendClientContent(payload.clientContent); } catch (e) { console.error('clientContent err:', e.message); }
        }
      } catch (err) {
        console.error('WS message parse error:', err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[${new Date().toISOString()}] WS closed`);
      clearInterval(audioFlushTimer);
      flushAudio();
      try { session.close(); } catch (_) {}
    });
  } catch (err) {
    console.error('Live API Connection Failed:', err);
    ws.close();
  }
});

// Guard against unhandled SDK promise rejections crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

await initializeQuotaStore();

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`FixEase AI backend listening on http://0.0.0.0:${port}`);
});

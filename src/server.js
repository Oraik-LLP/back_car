import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const port = Number(process.env.PORT || 8787);
const diagnosisModel = process.env.GEMINI_DIAGNOSIS_MODEL || 'gemini-flash-latest';
const liveHttpModel = 'gemini-flash-lite-latest'; // Must be REST compatible
const liveModel = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

function getAi() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing GEMINI_API_KEY');
    error.statusCode = 500;
    error.errorCode = 'missing_api_key';
    throw error;
  }
  return new GoogleGenAI({ apiKey });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    diagnosis_model: diagnosisModel,
    live_model: liveModel,
  });
});

app.post('/api/diagnose/symptoms', async (req, res) => {
  try {
    const { vehicle, symptoms = [], severity = 'medium', description } = req.body ?? {};
    const prompt = buildSymptomPrompt({ vehicle, symptoms, severity, description });
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

app.post('/api/diagnose/photos', async (req, res) => {
  try {
    const { vehicle, images = [], description } = req.body ?? {};
    const contents = [
      {
        role: 'user',
        parts: [
          { text: buildPhotoPrompt({ vehicle, description }) },
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
    res.json(normalized);
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/live/text', async (req, res) => {
  try {
    const { vehicle, history = [], message = '' } = req.body ?? {};
    const prompt = buildLiveTextPrompt({ vehicle, history, message });
    const text = await generateText({ model: liveHttpModel, prompt });
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

app.post('/api/live/frame', async (req, res) => {
  try {
    const { vehicle, history = [], message = '', image } = req.body ?? {};
    const parts = [
      {
        text: buildLiveFramePrompt({ vehicle, history, message }),
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
app.post('/api/live/voice', async (req, res) => {
  try {
    const { vehicle, history = [], audio, image } = req.body ?? {};

    const systemPrompt = `You are FixEase Live, a friendly expert automotive diagnostic assistant having a real-time voice conversation.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

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

async function generateText({ model, prompt, responseMimeType }) {
  return generateContent({
    model,
    responseMimeType,
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
  });
}

async function generateContent({ model, contents, responseMimeType }) {
  const ai = getAi();
  const response = await ai.models.generateContentStream({
    model,
    contents,
    config: {
      ...(responseMimeType ? { responseMimeType } : {}),
    },
  });

  let text = '';
  for await (const chunk of response) {
    if (chunk.text) {
      text += chunk.text;
    }
  }
  return text.trim();
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
  return `You are FixEase, an expert automotive diagnostic AI. Analyze the following vehicle symptoms and return JSON only.

VEHICLE:
- ${vehicle?.display_name || 'Unknown vehicle'}
- Fuel: ${vehicle?.fuel_label || 'Unknown'}
- Mileage: ${vehicle?.mileage_km || 0} km
${vehicle?.last_service_date ? `- Last service: ${vehicle.last_service_date}` : '- Last service: Unknown'}

REPORTED SYMPTOMS:
${symptoms.map((item) => `- ${item}`).join('\n')}

SEVERITY: ${severity}
${description ? `ADDITIONAL NOTES: ${description}` : ''}

Return ONLY a JSON object with this structure:
{
  "summary": "Brief 2-3 sentence overview of the likely issue",
  "health_score": 0.0,
  "confidence": 0.0,
  "possible_causes": ["cause1"],
  "recommendations": ["action1"],
  "sub_scores": {"Engine": 0, "Brakes": 0, "Transmission": 0, "Electrical": 0, "Suspension": 0},
  "urgency_note": "string or null"
}`;
}

function buildPhotoPrompt({ vehicle, description }) {
  return `You are FixEase, an expert automotive diagnostic AI with computer vision. Analyze the attached vehicle photos and return JSON only.

VEHICLE:
- ${vehicle?.display_name || 'Unknown vehicle'}
- Fuel: ${vehicle?.fuel_label || 'Unknown'}
- Mileage: ${vehicle?.mileage_km || 0} km
${description ? `USER DESCRIPTION: ${description}` : ''}

Examine the images for:
- visible damage
- fluid leaks
- tire condition
- rust or corrosion
- worn belts, hoses, or connectors
- dashboard warning lights
- any other anomalies

Return ONLY a JSON object with this structure:
{
  "summary": "Brief 2-3 sentence overview of what you see",
  "health_score": 0.0,
  "confidence": 0.0,
  "possible_causes": ["issue1"],
  "recommendations": ["action1"],
  "sub_scores": {"Body": 0, "Tires": 0, "Engine Bay": 0, "Fluids": 0, "Interior": 0},
  "urgency_note": "string or null"
}`;
}

function buildLiveTextPrompt({ vehicle, history, message }) {
  return `You are FixEase Live, a real-time automotive diagnostic assistant.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

USER: ${message}

Respond in 2-4 sentences. Be specific, practical, and ask for clarification if needed.`;
}

function buildLiveFramePrompt({ vehicle, history, message }) {
  return `You are FixEase Live, a real-time automotive diagnostic assistant reviewing a fresh camera frame.

VEHICLE: ${vehicle?.display_name || 'Unknown'} (${vehicle?.fuel_label || 'Unknown fuel'}, ${vehicle?.mileage_km || 0} km)

CONVERSATION SO FAR:
${history.map((item) => `${item.role?.toUpperCase?.() || 'USER'}: ${item.text || ''}`).join('\n')}

The user captured a frame and said: "${message}"

Analyze the image and respond in 2-4 sentences. Name likely issues clearly. If needed, ask for another angle or a closer shot.`;
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
    const ai = getAi();
    const session = await ai.live.connect({
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

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`FixEase AI backend listening on http://0.0.0.0:${port}`);
});

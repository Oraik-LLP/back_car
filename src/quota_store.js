import { Pool } from 'pg';

const freeDiagnosticsLimit = Number(process.env.FREE_DIAGNOSTICS_LIMIT || 3);
const quotaWindowDays = Number(process.env.FREE_DIAGNOSTIC_WINDOW_DAYS || 30);
const runningInProduction = process.env.NODE_ENV === 'production';

let pool = null;
let initialized = false;

const memoryQuotaState = new Map();
const memoryLiveSessions = new Set();

function nowUtc() {
  return new Date();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function normalizePlan(plan) {
  const value = String(plan || 'free').toLowerCase();
  if (value === 'pro' || value === 'emergency' || value === 'emergency_pass') {
    return 'pro';
  }
  return 'free';
}

function isPremiumPlan(plan) {
  return normalizePlan(plan) === 'pro';
}

function buildStatus({
  used,
  windowStartedAt,
  allowOverride,
  unlimited = false,
  sessionConsumed = false,
}) {
  const remaining = unlimited
    ? 9999
    : Math.max(0, freeDiagnosticsLimit - used);
  const resetAt = addDays(windowStartedAt, quotaWindowDays);
  return {
    allowed: allowOverride ?? (unlimited || remaining > 0 || sessionConsumed),
    unlimited,
    limit: freeDiagnosticsLimit,
    used,
    remaining,
    windowDays: quotaWindowDays,
    resetAt,
    sessionConsumed,
  };
}

export async function initializeQuotaStore() {
  if (initialized) return;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (runningInProduction) {
      throw new Error(
        'DATABASE_URL is required in production for server-side quota enforcement.',
      );
    }
    console.warn(
      '[QuotaStore] DATABASE_URL not configured. Using in-memory quota state for local development only.',
    );
    initialized = true;
    return;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS diagnostic_device_quotas (
      device_id TEXT PRIMARY KEY,
      free_scans_used INTEGER NOT NULL DEFAULT 0,
      quota_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS diagnostic_live_quota_sessions (
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (device_id, session_id)
    );
  `);

  initialized = true;
}

export async function getDiagnosticQuotaStatus({
  deviceId,
  plan,
  liveSessionId,
}) {
  await initializeQuotaStore();

  if (!deviceId) {
    throw createQuotaError(
      400,
      'device_id_missing',
      'FixEase could not verify this device for scan access.',
      false,
    );
  }

  if (isPremiumPlan(plan)) {
    const currentTime = nowUtc();
    return buildStatus({
      used: 0,
      windowStartedAt: currentTime,
      unlimited: true,
      allowOverride: true,
    });
  }

  if (!pool) {
    return getMemoryStatus({ deviceId, liveSessionId });
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const row = await ensureQuotaRow(client, deviceId);
    const liveSessionConsumed = await hasConsumedLiveSession(
      client,
      deviceId,
      liveSessionId,
    );

    await client.query('COMMIT');
    return buildStatus({
      used: row.free_scans_used,
      windowStartedAt: row.quota_window_started_at,
      sessionConsumed: liveSessionConsumed,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw wrapQuotaStoreError(error);
  } finally {
    client?.release();
  }
}

export async function consumeDiagnosticQuota({
  deviceId,
  plan,
  liveSessionId,
}) {
  await initializeQuotaStore();

  if (!deviceId) {
    throw createQuotaError(
      400,
      'device_id_missing',
      'FixEase could not verify this device for scan access.',
      false,
    );
  }

  if (isPremiumPlan(plan)) {
    const currentTime = nowUtc();
    return buildStatus({
      used: 0,
      windowStartedAt: currentTime,
      unlimited: true,
      allowOverride: true,
    });
  }

  if (!pool) {
    return consumeMemoryQuota({ deviceId, liveSessionId });
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const row = await ensureQuotaRow(client, deviceId, true);
    const liveSessionConsumed = await hasConsumedLiveSession(
      client,
      deviceId,
      liveSessionId,
      true,
    );

    if (liveSessionConsumed) {
      await client.query('COMMIT');
      return buildStatus({
        used: row.free_scans_used,
        windowStartedAt: row.quota_window_started_at,
        sessionConsumed: true,
      });
    }

    if (row.free_scans_used >= freeDiagnosticsLimit) {
      throw createQuotaError(
        402,
        'free_quota_exhausted',
        'Your free FixEase diagnostics are used up for now. Upgrade to keep scanning.',
        false,
      );
    }

    const nextUsed = row.free_scans_used + 1;
    const updated = await client.query(
      `
        UPDATE diagnostic_device_quotas
        SET free_scans_used = $2,
            updated_at = NOW(),
            last_seen_at = NOW()
        WHERE device_id = $1
        RETURNING free_scans_used, quota_window_started_at
      `,
      [deviceId, nextUsed],
    );

    if (liveSessionId) {
      await client.query(
        `
          INSERT INTO diagnostic_live_quota_sessions (device_id, session_id)
          VALUES ($1, $2)
          ON CONFLICT (device_id, session_id) DO NOTHING
        `,
        [deviceId, liveSessionId],
      );
    }

    await client.query('COMMIT');
    const resultRow = updated.rows[0];
    return buildStatus({
      used: resultRow.free_scans_used,
      windowStartedAt: resultRow.quota_window_started_at,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw wrapQuotaStoreError(error);
  } finally {
    client?.release();
  }
}

export async function resetDiagnosticQuota({
  deviceId,
}) {
  await initializeQuotaStore();

  if (!deviceId) {
    throw createQuotaError(
      400,
      'device_id_missing',
      'FixEase could not verify this device for scan access.',
      false,
    );
  }

  const currentTime = nowUtc();

  if (!pool) {
    memoryQuotaState.set(deviceId, {
      freeScansUsed: 0,
      quotaWindowStartedAt: currentTime,
      lastSeenAt: currentTime,
    });
    for (const finalKey of [...memoryLiveSessions]) {
      if (finalKey.startsWith(`${deviceId}:`)) {
        memoryLiveSessions.delete(finalKey);
      }
    }
    return buildStatus({
      used: 0,
      windowStartedAt: currentTime,
    });
  }

  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    await client.query(
      `
        INSERT INTO diagnostic_device_quotas (
          device_id,
          free_scans_used,
          quota_window_started_at,
          created_at,
          updated_at,
          last_seen_at
        )
        VALUES ($1, 0, $2, NOW(), NOW(), NOW())
        ON CONFLICT (device_id) DO UPDATE
        SET free_scans_used = 0,
            quota_window_started_at = $2,
            updated_at = NOW(),
            last_seen_at = NOW()
      `,
      [deviceId, currentTime],
    );

    await client.query(
      `
        DELETE FROM diagnostic_live_quota_sessions
        WHERE device_id = $1
      `,
      [deviceId],
    );

    await client.query('COMMIT');
    return buildStatus({
      used: 0,
      windowStartedAt: currentTime,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw wrapQuotaStoreError(error);
  } finally {
    client?.release();
  }
}

function getMemoryStatus({ deviceId, liveSessionId }) {
  const currentTime = nowUtc();
  const state = getMemoryRow(deviceId, currentTime);
  const liveSessionConsumed = liveSessionId
    ? memoryLiveSessions.has(`${deviceId}:${liveSessionId}`)
    : false;

  return buildStatus({
    used: state.freeScansUsed,
    windowStartedAt: state.quotaWindowStartedAt,
    sessionConsumed: liveSessionConsumed,
  });
}

function consumeMemoryQuota({ deviceId, liveSessionId }) {
  const currentTime = nowUtc();
  const state = getMemoryRow(deviceId, currentTime);
  const sessionKey = liveSessionId ? `${deviceId}:${liveSessionId}` : null;

  if (sessionKey && memoryLiveSessions.has(sessionKey)) {
    return buildStatus({
      used: state.freeScansUsed,
      windowStartedAt: state.quotaWindowStartedAt,
      sessionConsumed: true,
    });
  }

  if (state.freeScansUsed >= freeDiagnosticsLimit) {
    throw createQuotaError(
      402,
      'free_quota_exhausted',
      'Your free FixEase diagnostics are used up for now. Upgrade to keep scanning.',
      false,
    );
  }

  state.freeScansUsed += 1;
  state.lastSeenAt = currentTime;
  if (sessionKey) {
    memoryLiveSessions.add(sessionKey);
  }

  return buildStatus({
    used: state.freeScansUsed,
    windowStartedAt: state.quotaWindowStartedAt,
  });
}

function getMemoryRow(deviceId, currentTime) {
  let state = memoryQuotaState.get(deviceId);
  if (!state) {
    state = {
      freeScansUsed: 0,
      quotaWindowStartedAt: currentTime,
      lastSeenAt: currentTime,
    };
    memoryQuotaState.set(deviceId, state);
  }

  if (currentTime >= addDays(state.quotaWindowStartedAt, quotaWindowDays)) {
    state.freeScansUsed = 0;
    state.quotaWindowStartedAt = currentTime;
  }

  state.lastSeenAt = currentTime;
  return state;
}

async function ensureQuotaRow(client, deviceId, forUpdate = false) {
  const currentTime = nowUtc();
  await client.query(
    `
      INSERT INTO diagnostic_device_quotas (
        device_id,
        free_scans_used,
        quota_window_started_at,
        created_at,
        updated_at,
        last_seen_at
      )
      VALUES ($1, 0, $2, NOW(), NOW(), NOW())
      ON CONFLICT (device_id) DO NOTHING
    `,
    [deviceId, currentTime],
  );

  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  let queryResult = await client.query(
    `
      SELECT device_id, free_scans_used, quota_window_started_at
      FROM diagnostic_device_quotas
      WHERE device_id = $1
      ${lockClause}
    `,
    [deviceId],
  );

  let row = queryResult.rows[0];
  const quotaWindowEndsAt = addDays(row.quota_window_started_at, quotaWindowDays);

  if (currentTime >= quotaWindowEndsAt) {
    const resetResult = await client.query(
      `
        UPDATE diagnostic_device_quotas
        SET free_scans_used = 0,
            quota_window_started_at = $2,
            updated_at = NOW(),
            last_seen_at = NOW()
        WHERE device_id = $1
        RETURNING device_id, free_scans_used, quota_window_started_at
      `,
      [deviceId, currentTime],
    );
    row = resetResult.rows[0];
  } else {
    await client.query(
      `
        UPDATE diagnostic_device_quotas
        SET last_seen_at = NOW(),
            updated_at = NOW()
        WHERE device_id = $1
      `,
      [deviceId],
    );
  }

  return row;
}

async function hasConsumedLiveSession(client, deviceId, liveSessionId, forUpdate = false) {
  if (!liveSessionId) return false;
  const lockClause = forUpdate ? 'FOR UPDATE' : '';
  const result = await client.query(
    `
      SELECT 1
      FROM diagnostic_live_quota_sessions
      WHERE device_id = $1 AND session_id = $2
      ${lockClause}
    `,
    [deviceId, liveSessionId],
  );
  return result.rowCount > 0;
}

function createQuotaError(statusCode, errorCode, message, retryable) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  error.retryable = retryable;
  return error;
}

function wrapQuotaStoreError(error) {
  if (error?.statusCode && error?.errorCode) {
    return error;
  }

  console.error('[QuotaStore]', error);
  return createQuotaError(
    503,
    'quota_verification_unavailable',
    'FixEase could not verify scan access right now. Please try again shortly.',
    true,
  );
}

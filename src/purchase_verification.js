// Only this server's RevenueCat secret key can establish paid API access.
// The client plan header is a hint, never evidence of a purchase.
export function createPurchaseVerifier({
  secretKey = process.env.REVENUECAT_SECRET_API_KEY,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const ttlMs = 2 * 60 * 1000;
  const error = (message, statusCode = 503) => Object.assign(new Error(message), {
    statusCode, errorCode: 'purchase_verification_unavailable', retryable: true,
  });

  return async function verifyRequestPlan(req) {
    const claimed = String(req.headers['x-fixease-plan'] || 'free').toLowerCase();
    if (!['pro', 'emergencypass', 'emergency_pass'].includes(claimed)) return 'free';
    const customerId = String(req.headers['x-fixease-customer-id'] || '').trim();
    if (!/^[A-Za-z0-9_$:.-]{1,200}$/.test(customerId)) {
      throw error('Update FixEase and restore purchases to verify paid API access.', 401);
    }
    if (!secretKey) {
      throw error('Paid purchase verification is not configured on the server.');
    }
    const cached = cache.get(customerId);
    if (cached && now() < cached.expiresAt) return cached.plan;
    let response;
    try {
      response = await fetchImpl(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(customerId)}`,
        { headers: { Authorization: `Bearer ${secretKey}` },
          signal: AbortSignal.timeout(5000) },
      );
    } catch {
      throw error('The purchase service is temporarily unavailable. Please try again.');
    }
    if (!response.ok) {
      // Verification outages must not silently consume a paid user's free quota.
      throw error('Your paid access could not be refreshed. Please try again.');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw error('The purchase service returned an invalid response.');
    }
    if (!payload?.subscriber || typeof payload.subscriber.entitlements !== 'object' ||
        payload.subscriber.entitlements === null) {
      throw error('The purchase service returned an invalid response.');
    }
    const entitlements = payload.subscriber.entitlements;
    const pro = entitlements.ENTITLEMENT_PRO;
    const pass = entitlements.ENTITLEMENT_EMERGENCY;
    const currentTime = now();
    const deadline = (entry) => {
      if (!entry) return NaN;
      if (entry.expires_date === null) return Infinity;
      const expires = Date.parse(entry.expires_date);
      if (!Number.isFinite(expires)) return NaN;
      const grace = Date.parse(entry.grace_period_expires_date);
      return Number.isFinite(grace) ? Math.max(expires, grace) : expires;
    };
    const active = (entry) => deadline(entry) > currentTime;
    const passPurchase = Date.parse(pass?.purchase_date);
    const validPass = active(pass) && Number.isFinite(passPurchase) &&
      passPurchase <= currentTime && passPurchase + 48 * 60 * 60 * 1000 > currentTime;
    const plan = active(pro) || validPass ? 'pro' : 'free';
    // Cap memory, never retain a stale decision across a verification outage,
    // and never cache beyond the actual paid period.
    const relevant = active(pro) ? pro : validPass ? pass : null;
    const purchaseDeadline = validPass && !active(pro)
      ? passPurchase + 48 * 60 * 60 * 1000 : Infinity;
    const expires = deadline(relevant);
    const expiresAt = Math.min(currentTime + ttlMs, purchaseDeadline,
      Number.isFinite(expires) ? expires : Infinity);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value);
    cache.set(customerId, { plan, expiresAt });
    return plan;
  };
}

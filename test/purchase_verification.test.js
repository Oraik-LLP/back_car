import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseVerifier } from '../src/purchase_verification.js';

const timestamp = Date.parse('2026-11-05T12:00:00Z');
const paidRequest = { headers: {
  'x-fixease-plan': 'pro', 'x-fixease-customer-id': '$RCAnonymousID:test123',
} };
const response = (entitlements) => ({ ok: true,
  json: async () => ({ subscriber: { entitlements } }),
});
const verifier = (entitlements, options = {}) => createPurchaseVerifier({
  secretKey: 'server-only-test-key', now: () => timestamp,
  fetchImpl: async () => response(entitlements), ...options,
});

test('a plan header alone cannot grant premium', async () => {
  await assert.rejects(verifier({})({ headers: { 'x-fixease-plan': 'pro' } }),
    (e) => e.statusCode === 401);
});
test('free requests do not require RevenueCat or its secret', async () => {
  assert.equal(await createPurchaseVerifier()({ headers: {} }), 'free');
});
test('paid requests fail explicitly if server verification is unconfigured', async () => {
  await assert.rejects(createPurchaseVerifier({ secretKey: '' })(paidRequest),
    (e) => e.statusCode === 503);
});
test('a real current Pro entitlement grants paid API access', async () => {
  assert.equal(await verifier({ ENTITLEMENT_PRO: {
    expires_date: '2026-12-05T12:00:00Z',
  } })(paidRequest), 'pro');
});
test('an expired or revoked entitlement cannot bypass quotas', async () => {
  assert.equal(await verifier({ ENTITLEMENT_PRO: {
    expires_date: '2026-11-04T12:00:00Z',
  } })(paidRequest), 'free');
  assert.equal(await verifier({})(paidRequest), 'free');
});
test('server-confirmed billing grace is honored', async () => {
  assert.equal(await verifier({ ENTITLEMENT_PRO: {
    expires_date: '2026-11-04T12:00:00Z',
    grace_period_expires_date: '2026-11-06T12:00:00Z',
  } })(paidRequest), 'pro');
});
test('Emergency Pass is limited to 48 hours even for a nonexpiring product', async () => {
  assert.equal(await verifier({ ENTITLEMENT_EMERGENCY: {
    expires_date: null, purchase_date: '2026-11-04T12:00:00Z',
  } })(paidRequest), 'pro');
  assert.equal(await verifier({ ENTITLEMENT_EMERGENCY: {
    expires_date: null, purchase_date: '2026-11-03T12:00:00Z',
  } })(paidRequest), 'free');
});
test('verification outage does not silently downgrade paid requests to free', async () => {
  await assert.rejects(verifier({}, { fetchImpl: async () => { throw Error('offline'); } })(paidRequest),
    (e) => e.statusCode === 503);
});
test('a response with missing subscriber data cannot grant premium', async () => {
  await assert.rejects(verifier({}, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })(paidRequest),
    (e) => e.statusCode === 503);
});
test('cache never extends paid access past the actual expiry', async () => {
  let currentTime = timestamp;
  let calls = 0;
  const check = verifier({}, { now: () => currentTime, fetchImpl: async () => {
    calls++;
    return response({ ENTITLEMENT_PRO: { expires_date: '2026-11-05T12:00:30Z' } });
  } });
  assert.equal(await check(paidRequest), 'pro');
  currentTime += 31000;
  assert.equal(await check(paidRequest), 'free');
  assert.equal(calls, 2);
});

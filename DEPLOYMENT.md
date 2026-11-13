# FixEase backend 1.1.0

Deploy `main` using the existing host. The application remains a Node/Express HTTP and WebSocket service; this update does not migrate it to a Cloudflare Worker. An optional Dockerfile is included for container hosts. Preserve existing Gemini model settings, database URL, quotas and secrets.

Required server secret: `REVENUECAT_SECRET_API_KEY` (RevenueCat API v1 secret with subscriber read access). Never put this secret in Flutter, Git, the website or the APK. Keep the existing `GEMINI_API_KEY`/provider configuration.

Paid requests now require `x-fixease-customer-id` as well as a plan hint. RevenueCat establishes the entitlement; a plan header alone receives 401. RevenueCat outages return 503 without silently using free quota. Older app builds that do not send customer IDs must update and restore purchases. Coordinate this rollout with the new Android build.

After deployment:

1. `/health` must show `release: 1.1.0-v17`, `purchase_verification: revenuecat-server-v1`, and `vehicle_recognition: 1`.
2. Quota status with a `pro` plan but no customer ID must return 401.
3. Check a genuine RevenueCat test customer's current and expired entitlements through the app. No real paid customer's data is included in this repository.
4. Run a symptom diagnosis and a one/two-photo recognition request. A second photo is requested only when helpful; manual identification remains available on errors.

Run pure validation tests with `node --test test/*.test.js`. These tests do not contact Gemini or RevenueCat. AI inference runs online through the configured backend; no model is packaged for offline execution.

Limitations: anonymous RevenueCat IDs are not an authenticated account system. Stronger resistance to ID replay requires authenticated account ownership and platform attestation. Client-controlled device IDs also make free-tier quotas and recognition throttles best-effort. Do not describe this release as crack-proof.

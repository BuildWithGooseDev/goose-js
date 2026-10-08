// Server-side (Node) example: read flags, watch app configs, and receive webhook
// deltas — the secret-bearing features that must NOT run in a browser. Build the
// SDK first (`cd sdks/js && npm install && npm run build`), then run with:
//
//   GOOSE_SERVER_URL=http://localhost:8080 \
//   GOOSE_CLIENT_ID=gsc_... GOOSE_CLIENT_SECRET=... \
//   GOOSE_FLAGSET=checkout GOOSE_NAMESPACE=production \
//   node sdks/js/example/node.mjs
//
// Optional: GOOSE_CONFIGS=frontend,database to watch configs, and
// GOOSE_WEBHOOK_TARGET_URL=http://host:8091/webhook to enable webhook mode.
import { GooseSDK } from "../dist/index.js";

const env = (key, fallback = "") => (process.env[key] ?? "").trim() || fallback;

const serverUrl = env("GOOSE_SERVER_URL", "http://localhost:8080");
const clientId = env("GOOSE_CLIENT_ID");
const clientSecret = env("GOOSE_CLIENT_SECRET");
const flagset = env("GOOSE_FLAGSET", "checkout");
const namespaceName = env("GOOSE_NAMESPACE") || undefined;
const configs = env("GOOSE_CONFIGS")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const webhookTargetUrl = env("GOOSE_WEBHOOK_TARGET_URL") || undefined;
// Optional: this app's own version. When set, config entries carrying
// min_app_version/max_app_version are gated against it — an entry out of range
// resolves to its "default" instead of its "value", and a change to it never
// triggers a restart. Omit it and every entry applies.
const appVersion = env("GOOSE_APP_VERSION") || undefined;

if (!clientId) {
  console.error("Set GOOSE_CLIENT_ID before running the example.");
  process.exit(1);
}

// Watching configs or using webhooks is secret-bearing, so they need a secret.
const wantsSecretFeatures = configs.length > 0 || Boolean(webhookTargetUrl);
if (wantsSecretFeatures && !clientSecret) {
  console.error("Set GOOSE_CLIENT_SECRET to watch configs or use webhooks.");
  process.exit(1);
}

const client = new GooseSDK({
  clientId,
  clientSecret: clientSecret || undefined,
  serverUrl,
  flagsets: flagset,
  namespaceName,
  // Webhook mode pushes deltas to an embedded listener; otherwise poll + SSE.
  connectionType: webhookTargetUrl ? ["polling", "webhook"] : ["polling", "sse"],
  configs: configs.length > 0 ? configs : undefined,
  appVersion,
  webhookTargetUrl,
  pollIntervalSeconds: 3,
  autoConnect: false,
});

// React to live flag changes (polling, SSE, and webhook all feed this).
client.onChange(({ flagset: fs, flagKey, value, previousValue }) => {
  const before = previousValue === undefined ? "(unset)" : JSON.stringify(previousValue);
  console.log(`[flag] ${fs}.${flagKey}: ${before} -> ${JSON.stringify(value)}`);
});

// React to config document changes.
for (const name of configs) {
  client.on(name, ({ applyStrategy, newValue }) => {
    console.log(`[config] ${name} changed (${applyStrategy}):`, JSON.stringify(newValue));
  });
}
client.onRestartRequired(({ name }) => {
  console.log(`[config] draining for restart; '${name}' has a requires_restart entry`);
});

await client.connect();

console.log("Connected. Initial flags:", client.snapshot()[flagset] ?? {});
if (configs.length > 0) {
  console.log("Initial configs:", client.configsSnapshot());
}
if (webhookTargetUrl) {
  console.log("Webhook listener:", client.webhookListenerUrl);
}

// Canary read: a flag with a rollout buckets on the targeting key; flags without
// one ignore it and return their stored value.
console.log("canary_demo for user-123:", await client.getFlag("canary_demo", { targetingKey: "user-123" }));

console.log("Watching for changes. Press Ctrl+C to stop.");
process.on("SIGINT", () => {
  console.log("\nStopping...");
  client.close();
  process.exit(0);
});

# Goose JavaScript SDK

A JavaScript/TypeScript SDK for the Goose config service. It reads feature flags
by **polling** and/or a live **SSE** stream, evaluates **canary rollouts**
client-side, and emits change events.

It has **no runtime dependencies** and ships as ESM with TypeScript types. It
runs in **browsers** (flags only) and in **server runtimes** — Node 18+, Deno,
Bun — where, given a client secret, it also supports **app configs** and
**webhooks**.

## ⚠️ Browser vs. server: what's safe where

> **A browser cannot keep a secret.** Anything the SDK sends — headers, query
> params, request bodies — is fully visible in the browser's network inspector
> and is trivially extracted from shipped JS.
>
> **In a browser, use the client id only.** The `clientId` (`gsc_…`) is a
> *public, publishable identifier* (think a Stripe publishable key), not a
> credential to protect. Exposing it only ever reveals flag *values*, which the
> browser can already see anyway. With just a client id the SDK reads flags via
> polling and/or SSE — that's it.
>
> **Configs and webhooks are server-side only.** They require a `clientSecret`:
>
> - **App configs** — config documents can embed server-resolved secrets (e.g.
>   `${db_password}`), so the server requires a client secret to read them.
> - **Webhook registration** — also secret-bearing, and the embedded webhook
>   listener needs an HTTP server (`node:http`), which browsers don't have.
>
> 🚫 **Never put a `clientSecret`, `configs`, or `connectionType: "webhook"` in
> code that ships to a browser.** A bundled secret is a leaked secret. Run those
> features in a server runtime (Node/Deno/Bun) only. The SDK throws if you
> request a secret-bearing feature without a `clientSecret`, but it cannot tell
> whether your code is running in a browser — that's on you.

## Install & build

```bash
cd sdks/js
npm install
npm run build   # emits dist/ (ESM + .d.ts)
```

## Test

The suite uses Node's built-in test runner (no extra dependencies); it builds the
SDK and exercises it against an in-process stub of the config service — flag
polling, canary bucketing, configs, and the embedded webhook listener:

```bash
cd sdks/js
npm test
```

## Usage

```js
import { GooseSDK } from "@goose/sdk"; // or "../dist/index.js" when running from source

const client = new GooseSDK({
  clientId: "gsc_your_client_id", // public, non-secret
  serverUrl: "https://goose.example.com",
  flagsets: "checkout",
  connectionType: ["polling", "sse"], // "polling" (default), "sse", or both
  namespaceName: "production",
  autoConnect: false,
});

await client.connect();

// Read a flag (typed: bool -> boolean, number -> number, string/list -> string).
// getFlag is async because canary evaluation hashes via Web Crypto.
if (await client.getFlag("edge_ui", { default: false })) {
  renderNewCheckout();
}

// React to live changes (polling + SSE both feed this).
const unsubscribe = client.onChange(({ flagset, flagKey, value, previousValue }) => {
  console.log(`[${flagset}] ${flagKey}: ${previousValue} -> ${value}`);
});

// Canary rollouts: pass a stable per-user key. In-bucket users get the candidate
// value, everyone else the baseline. Bucketing is deterministic and sticky, so
// growing the percentage never reshuffles existing users.
const enabled = await client.getFlag("edge_ui", { targetingKey: currentUser.id });

// Later:
unsubscribe();
client.close();
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `clientId` | `string` | — | Required. Public `gsc_…` identifier. |
| `serverUrl` | `string` | — | Required. Base URL of the config service. |
| `flagsets` | `string \| string[]` | — | Required. One or more flagset names. |
| `connectionType` | `"polling" \| "sse" \| (…)[]` | `"polling"` | Combine both for snapshot + live stream. |
| `namespaceName` | `string` | — | Default namespace for all flagsets. |
| `flagsetNamespaces` | `Record<string,string>` | — | Per-flagset namespace overrides. |
| `defaultTargetingKey` | `string` | — | Fallback bucketing key for canary rollouts. |
| `storageAdapter` | `StorageAdapter` | — | Mirror values into an external store. |
| `pollIntervalSeconds` | `number` | `5` | Polling cadence (floored at 1). |
| `requestTimeoutSeconds` | `number` | `10` | Per-request timeout for non-stream calls. |
| `autoConnect` | `boolean` | `true` | Set `false` to `await connect()` yourself. |

Server-side only (require `clientSecret`; **never use in a browser**):

| Option | Type | Default | Notes |
|---|---|---|---|
| `clientSecret` | `string` | — | Required for configs/webhooks. Server-side only. |
| `configs` | `string[]` | — | Config document names to watch (needs `namespaceName`). |
| `restartOnRequiredChange` | `boolean` | `false` | Raise SIGINT after drains on a requires_restart change (Node). |
| `connectionType: "webhook"` | — | — | Embedded Node listener applies pushed deltas. |
| `webhookTargetUrl` | `string` | — | Public URL the server posts deltas to (required for webhook). |
| `webhookSecret` | `string` | auto | Shared webhook secret (auto-generated if omitted). |
| `webhookNamePrefix` | `string` | `goose-js-sdk` | Prefix for registered webhook names. |
| `webhookListenerEnabled` | `boolean` | `true` | Start the embedded `node:http` listener. |
| `webhookListenerHost` | `string` | `0.0.0.0` | Embedded listener bind host. |
| `webhookListenerPort` | `number` | `8091` | Embedded listener port. |
| `webhookListenerPath` | `string` | from target URL | Embedded listener path. |

### API

- `connect()` / `close()` / `refresh()` — lifecycle.
- `getFlag(flagKey, { flagset?, default?, targetingKey? })` → `Promise<FlagValue>`.
- `snapshot()` → `{ flagset: { flagKey: value } }` of stored (baseline) values.
- `onChange(listener)` → unsubscribe function; fires on every flag value change.
- `state()` / `lastSync()` / `isStale()` — connection health (see below).
- `onStateChange(listener)` / `onError(listener)` → unsubscribe functions.

Server-side (configs + webhooks):

- `getConfig(name, fallback?)` → the watched config's whole document.
- `getConfigValue(name, key, fallback?)` → a single entry's value.
- `configsSnapshot()` → `{ name: document }`.
- `on(name, listener)` → unsubscribe; fires when that config document changes.
- `onRestartRequired(listener)` → unsubscribe; drain hook for requires_restart changes.
- `registerWebhooks()` / `processWebhookEvent(payload, receivedSecret?)`.
- `webhookListenerUrl` / `webhookEventsReceived` — listener metadata.

## Resilience & self-healing

The SDK keeps serving flags through outages, network blips, and process restarts.

**Reads never reject.** `getFlag` always resolves to a value from a fallback
ladder — the current value, else the last-known-good value, else your `default` —
and never rejects. Malformed values pushed from the server (e.g. a non-numeric
value for a number flag) are rejected and logged rather than corrupting the cache.

**Warm start (server-side).** Pass a `cache` to persist last-known-good state and
read it back on `connect()` **before** any network call, so a restart during an
outage boots with real values. `FileCache` is a built-in atomic file-backed store
(Node only — browsers have no filesystem, so omit it):

```js
import { GooseSDK, FileCache } from "@goose/sdk";

const client = new GooseSDK({ /* ... */ cache: new FileCache("/var/lib/app/goose-cache.json") });
```

**Graceful degraded start.** By default a failed initial fetch starts the client
in the `"degraded"` state and heals in the background instead of rejecting from
`connect()`. Set `requireInitialConnect: true` for fail-fast behavior.

**Disciplined reconnects.** SSE reconnects and post-error retries use exponential
backoff with jitter (capped), and honor a `429`'s `Retry-After`. A silently
half-open SSE stream is torn down by an idle watchdog (`sseReadTimeoutSeconds`)
and reconnected; in SSE-only mode a sustained outage falls back to polling.

**Observability.**

```js
client.state();      // "connecting" | "live" | "degraded" | "closed"
client.lastSync();   // epoch ms of the last successful sync, or null
client.isStale();    // true if no successful sync within the staleness window

client.onStateChange((s) => console.log("goose state:", s));
client.onError((err) => console.warn("goose background error:", err)); // never affects reads
```

## Configs (server-side)

> 🚫 Requires a `clientSecret` — run in Node/Deno/Bun, never a browser.

A **config** is a named JSON **document** inside `namespaceName`, shaped
`{ "configs": { "<entry>": { "value": <any>, "apply_strategy": "immediate" | "requires_restart" } } }`.
The client watches config **names**; each has its own document and revision, and
changes are delivered on the **polling** loop.

```js
import { GooseSDK } from "@goose/sdk";

const client = new GooseSDK({
  clientId: "gsc_…",
  clientSecret: process.env.GOOSE_CLIENT_SECRET, // server-side secret
  serverUrl: "https://goose.example.com",
  flagsets: "checkout",
  namespaceName: "production",        // required when watching configs
  configs: ["frontend", "database"],  // config NAMES to watch
  restartOnRequiredChange: true,      // opt in to SIGINT after drains (Node)
});

// Per-name listener; oldValue/newValue are full documents (oldValue is null on
// first sighting). applyStrategy is "requires_restart" when any changed entry is.
client.on("frontend", ({ name, oldValue, newValue, applyStrategy }) => {
  console.log(`${name} changed (${applyStrategy})`);
});

// Drain hook: always runs before a requires_restart change triggers a restart.
client.onRestartRequired(() => finishInFlightWork());

const frontend = client.getConfig("frontend", {});                       // whole document
const layout = client.getConfigValue("frontend", "dashboard_layout", "grid"); // one entry
const all = client.configsSnapshot();                                    // { name: document }
```

### Entry metadata

Beyond `value` and `apply_strategy`, an entry may carry optional metadata. The
server stores and delivers it untouched — none of it is a server-side gate — and
this SDK acts on it at read time, keyed off the `appVersion` option:

| Key | Type | What the SDK does with it |
|---|---|---|
| `default` | any | Served instead of `value` when the entry is gated out by app version |
| `min_app_version` | string | Lowest app version the entry applies to (**inclusive**) |
| `max_app_version` | string | Highest app version the entry applies to (**inclusive**) |
| `deprecated` | bool | Warns once, the first time the entry is read |
| `replaced_by` | string | Successor entry named in that deprecation warning |
| `sensitive` | bool | Keeps the value out of the on-disk `PersistentCache` |
| `required` | bool | Reports an error when the entry resolves to nothing |

Versions are lenient dotted strings — `"3"`, `"2.4"`, `"2.4.1"`, `"v2.4.1-rc.1"`
all parse, a leading `v` is dropped, and any pre-release/build suffix is ignored.
They must be **quoted**: unquoted `2.4` is a number, and both the editor and the
server reject it.

Everything fails open. A client built without an app version applies every
entry, an unparseable version or bound disables that gate, and a `default` is
only consulted for an entry that is actually gated out — so existing documents
and existing clients behave exactly as they did before.

```js
const client = new GooseSDK({
  clientId: "gsc_…",
  clientSecret: process.env.GOOSE_CLIENT_SECRET,
  serverUrl: "https://goose.example.com",
  flagsets: "checkout",
  namespaceName: "production",
  configs: ["frontend"],
  appVersion: "2.1.0", // optional; omit to apply every entry
});

// For an entry with min_app_version "2.4.0", this 2.1.0 build resolves to the
// entry's "default" rather than its "value".
const layout = client.getConfigValue("frontend", "dashboard_layout", "grid");
```

Gating applies to restarts too: a `requires_restart` change to an entry this
build is gated out of will not restart the process. `getConfig()` returns the
raw document, so reading `entry.value` out of it yourself bypasses all of the
above — `getConfigValue()` is where resolution happens.


Config documents can reference **secrets** as `${secret_name}` inside string
values; the server substitutes them **before delivery**, so the SDK needs no keys
and values arrive already resolved. Changing a secret behaves like a config
change — listeners fire with the newly resolved value.

## Webhook mode (server-side)

> 🚫 Requires a `clientSecret` and a Node-compatible runtime with `node:http` —
> the embedded listener is an HTTP server. Not for browsers.

```js
const client = new GooseSDK({
  clientId: "gsc_…",
  clientSecret: process.env.GOOSE_CLIENT_SECRET,
  serverUrl: "https://goose.example.com",
  flagsets: "checkout",
  connectionType: "webhook",
  webhookTargetUrl: "https://app.example.com/webhook", // public URL of this app
  webhookListenerPort: 8091,
});
await client.connect(); // starts the embedded listener and registers webhooks
```

The SDK starts an embedded listener and applies deltas internally — no handler
wiring required. Inspect it via `client.webhookListenerUrl` and
`client.webhookEventsReceived`. If you prefer your own HTTP route, set
`webhookListenerEnabled: false` and call
`client.processWebhookEvent(payload, req.headers["x-webhook-secret"])` yourself.

Webhooks are delivered **at-least-once** (each delta carries a unique `eventId`),
and the SDK applies each `eventId` at most once, so redeliveries are safe.
Webhook mode is **not** for horizontally scaled SDK consumers — use polling/SSE
for those.

## Example

A minimal browser app that prints flag deltas to the page lives in
[`example/`](./example). See its README to run it.

## CORS

The config service sends permissive CORS headers for its SDK endpoints, so a
browser page on any origin can call it. This is safe because authentication is
explicit in each request (the client id) and the service uses no cookies or
other ambient credentials.

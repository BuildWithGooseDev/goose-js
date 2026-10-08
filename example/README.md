# Browser example — live flag deltas

A minimal page that connects with a (non-secret) client id and prints every flag
delta to the screen, live, over polling + SSE.

## Run it

1. Build the SDK (the example imports the compiled `dist/`):

   ```bash
   cd sdks/js
   npm install
   npm run build
   ```

2. Serve this directory over HTTP (ES module imports and `fetch` don't work from
   `file://`). From `sdks/js`:

   ```bash
   python3 -m http.server 5500
   ```

3. Open <http://localhost:5500/example/> in a browser.

4. Fill in:
   - **Server URL** — your config service (default `http://localhost:8080`).
   - **Client ID** — a `gsc_…` id created under **SDK Access** in the dashboard.
   - **Flagset** / **Namespace** — what to watch.

   Click **Connect**. The initial snapshot prints, then toggle a flag in the
   dashboard and watch the delta appear here.

## Notes

- No secret is ever entered or sent — the client id is the only credential, by
  design (see the [SDK README](../README.md)).
- The config service must be reachable from the browser; it sends permissive
  CORS headers for its SDK endpoints, so a different origin/port is fine.
- **In the browser, use the client id only.** App configs and webhooks need a
  client secret a browser cannot keep — run those server-side. See
  [`node.mjs`](./node.mjs) for a Node example that uses configs and webhooks.

## Node example (configs + webhooks)

[`node.mjs`](./node.mjs) is a server-side example that reads flags, watches app
configs, and (optionally) receives webhook deltas — the secret-bearing features
that must not ship to a browser.

After building the SDK (`npm run build`), run it with your credentials:

```bash
GOOSE_SERVER_URL=http://localhost:8080 \
GOOSE_CLIENT_ID=gsc_... \
GOOSE_CLIENT_SECRET=... \
GOOSE_FLAGSET=checkout \
GOOSE_NAMESPACE=production \
GOOSE_CONFIGS=frontend,database \
GOOSE_APP_VERSION=2.4.0 \
node sdks/js/example/node.mjs
```

- `GOOSE_CLIENT_SECRET` is required only when `GOOSE_CONFIGS` or
  `GOOSE_WEBHOOK_TARGET_URL` is set.
- `GOOSE_APP_VERSION` is optional and switches on config **app-version gating**:
  an entry whose `min_app_version`/`max_app_version` range excludes that version
  resolves to its `default` instead of its `value`, and a change to it never
  triggers a restart. Omit it and every entry applies.
- Set `GOOSE_WEBHOOK_TARGET_URL=http://<public-host>:8091/webhook` to switch the
  flag stream to webhook mode (an embedded listener starts automatically).
- Stop with `Ctrl+C`.

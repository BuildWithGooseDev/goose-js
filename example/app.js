// Minimal browser example: connect with a (non-secret) client id and print
// every flag delta to the page. Run `npm run build` in sdks/js first, then
// serve this directory (see README) and open it in a browser.
import { GooseSDK } from "../dist/index.js";

const form = document.getElementById("connect-form");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const connectBtn = document.getElementById("connect-btn");

let client = null;

function log(message, className = "meta") {
  const line = document.createElement("div");
  line.className = className;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  logEl.prepend(line);
}

function logDelta({ flagset, flagKey, value, previousValue }) {
  const line = document.createElement("div");
  line.className = "delta";
  const before = previousValue === undefined ? "(unset)" : JSON.stringify(previousValue);
  line.innerHTML =
    `[${new Date().toLocaleTimeString()}] ` +
    `<span class="meta">${flagset}</span> ` +
    `<span class="key">${flagKey}</span> ` +
    `<span class="arrow">${before} → ${JSON.stringify(value)}</span>`;
  logEl.prepend(line);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (client) {
    client.close();
    client = null;
  }

  const serverUrl = document.getElementById("serverUrl").value.trim();
  const clientId = document.getElementById("clientId").value.trim();
  const flagset = document.getElementById("flagset").value.trim();
  const namespace = document.getElementById("namespace").value.trim();

  if (!clientId) {
    log("Enter a client id first.", "error");
    return;
  }

  connectBtn.disabled = true;
  statusEl.textContent = "Connecting…";

  client = new GooseSDK({
    clientId,
    serverUrl,
    flagsets: flagset,
    connectionType: ["polling", "sse"],
    namespaceName: namespace || undefined,
    pollIntervalSeconds: 3,
    autoConnect: false,
  });

  client.onChange(logDelta);

  try {
    await client.connect();
    const snapshot = client.snapshot();
    statusEl.textContent = `Connected to ${serverUrl} — flagset "${flagset}". Watching for deltas…`;
    log(`Initial snapshot: ${JSON.stringify(snapshot[flagset] ?? {})}`);
  } catch (error) {
    statusEl.textContent = "Connection failed.";
    log(`Connect failed: ${error?.message ?? error}`, "error");
    client.close();
    client = null;
  } finally {
    connectBtn.disabled = false;
  }
});

window.addEventListener("beforeunload", () => client?.close());

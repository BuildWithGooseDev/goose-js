// Shared test helpers: a stdlib http stub standing in for the config service.
import http from "node:http";
import net from "node:net";

/** Build a flag object as the config/poll endpoints return it. */
export function flag(key, dataType, value, extra = {}) {
  return {
    flag_key: key,
    flag_data_type: dataType,
    flag_value: value,
    updated_at: "2026-06-14T00:00:00Z",
    ...extra,
  };
}

/** Reserve a currently-free localhost TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start a stub config service. Returns { baseUrl, state, close }. Tests mutate
 * `state.flags` / `state.configs` to drive responses and read
 * `state.webhookRegistrations`.
 */
export async function startStub() {
  const state = { flags: [], configs: {}, webhookRegistrations: [] };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      const send = (payload, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };

      if (req.method === "GET" && path === "/api/v1/config") {
        send({ flags: state.flags });
      } else if (req.method === "POST" && path === "/api/v1/poll") {
        send({ flags: state.flags });
      } else if (req.method === "GET" && path === "/api/v1/configs") {
        send({ configs: state.configs });
      } else if (req.method === "POST" && path === "/api/v1/configs/poll") {
        send({ configs: state.configs });
      } else if (req.method === "POST" && path === "/api/v1/webhook") {
        state.webhookRegistrations.push(JSON.parse(body || "{}"));
        send({});
      } else {
        send({}, 404);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** POST a webhook delta to the SDK's embedded listener; returns the HTTP status. */
export async function postWebhook(url, payload, secret) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Webhook-Secret": secret } : {}),
    },
    body: JSON.stringify(payload),
  });
  return res.status;
}

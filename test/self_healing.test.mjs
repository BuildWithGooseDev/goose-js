// Self-healing behavior: warm start, degraded start, fault-tolerant reads,
// health API, and the SSE idle watchdog.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GooseSDK, FileCache } from "../dist/index.js";
import { flag, freePort, startStub } from "./helpers.mjs";

const base = {
  clientId: "gsc_x",
  flagsets: "default",
  autoConnect: false,
  pollIntervalSeconds: 60,
};

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goose-cache-"));
  return path.join(dir, "cache.json");
}

test("FileCache round-trips a snapshot", async () => {
  const cachePath = tmpCachePath();
  const cache = new FileCache(cachePath);
  assert.equal(await cache.load(), null);

  const snapshot = {
    flags: { default: { a: true, b: 3, c: "x" } },
    flagDataTypes: { default: { a: "bool", b: "number", c: "string" } },
    rollouts: { default: { b: { percentage: 25, salt: "s", value: 9 } } },
    pollCursors: { default: 1234 },
    configs: { frontend: { document: { configs: {} }, revision: 2 } },
  };
  await cache.save(snapshot);
  assert.deepEqual(await cache.load(), snapshot);
});

test("state and isStale reflect connection health", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("x", "bool", true)];
  const client = new GooseSDK({ ...base, serverUrl: stub.baseUrl });

  assert.equal(client.state(), "connecting");
  assert.equal(client.isStale(), true);

  await client.connect();
  assert.equal(client.state(), "live");
  assert.equal(client.isStale(), false);

  const states = [];
  client.onStateChange((s) => states.push(s));
  client.close();
  assert.equal(client.state(), "closed");
  assert.ok(states.includes("closed"));
  await stub.close();
});

test("a malformed delta is rejected and reads keep the last-known-good value", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("limit", "number", 10)];
  const errors = [];
  const client = new GooseSDK({ ...base, serverUrl: stub.baseUrl, onError: (e) => errors.push(e) });
  await client.connect();
  assert.equal(await client.getFlag("limit"), 10);

  // String value for a number flag: rejected, prior value retained.
  client.processWebhookEvent({ flagSet: "default", flagKey: "limit", flagValue: "not-a-number" });
  assert.equal(await client.getFlag("limit"), 10);
  assert.ok(errors.length > 0, "expected onError for malformed value");

  // A well-formed delta still applies.
  client.processWebhookEvent({ flagSet: "default", flagKey: "limit", flagValue: 20 });
  assert.equal(await client.getFlag("limit"), 20);

  client.close();
  await stub.close();
});

test("warm start: restart during an outage serves cached values and comes up degraded", async () => {
  const cachePath = tmpCachePath();
  let fail = false;
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path_ = req.url.split("?")[0];
      const send = (payload, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (fail) return send({}, 500);
      if (req.method === "GET" && path_ === "/api/v1/config") {
        send({ flags: [flag("feature_x", "bool", true)] });
      } else if (req.method === "GET" && path_ === "/api/v1/sdk/resolve") {
        send({ organization_id: "org1" });
      } else if (req.method === "POST" && path_ === "/api/v1/poll") {
        send({ flags: [] });
      } else {
        send({}, 404);
      }
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Client A populates + persists the cache from a healthy server.
    const a = new GooseSDK({ ...base, serverUrl: baseUrl, cache: new FileCache(cachePath) });
    await a.connect();
    assert.equal(a.state(), "live");
    assert.equal(await a.getFlag("feature_x"), true);
    await a.flushCache(); // deterministic persist
    a.close();

    // Outage: a restarting client must warm-start and not throw from connect().
    fail = true;
    const b = new GooseSDK({ ...base, serverUrl: baseUrl, cache: new FileCache(cachePath) });
    await b.connect();
    assert.equal(b.state(), "degraded");
    assert.equal(await b.getFlag("feature_x"), true); // served from warm-started cache
    b.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("requireInitialConnect makes connect() reject when the server is down", async () => {
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.statusCode = 500;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const client = new GooseSDK({
      ...base,
      serverUrl: `http://127.0.0.1:${port}`,
      requireInitialConnect: true,
    });
    await assert.rejects(() => client.connect());
    client.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("SSE idle watchdog tears down a silently stalled stream and reconnects", async () => {
  let connections = 0;
  const port = await freePort();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path_ = req.url.split("?")[0];
      if (req.method === "POST" && path_ === "/api/v1/sse") {
        connections += 1;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(": connected\n\n"); // then stall — never send anything else
      } else if (req.method === "GET" && path_ === "/api/v1/config") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ flags: [] }));
      } else {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  try {
    const client = new GooseSDK({
      clientId: "gsc_x",
      flagsets: "default",
      serverUrl: `http://127.0.0.1:${port}`,
      connectionType: "sse",
      autoConnect: false,
      onError: () => {}, // consume the abort-driven disconnect errors
    });
    // Shorten the idle deadline for a fast test (below the 5s floor default).
    client.sseReadTimeoutSeconds = 0.3;
    await client.connect();

    // Without the watchdog a stalled-but-connected stream would keep the client
    // "live" forever. The watchdog aborts it, so the loop records a failure and
    // the state flips to "degraded".
    await new Promise((resolve) => setTimeout(resolve, 700));
    const stateAfterStall = client.state();
    client.close();
    assert.equal(stateAfterStall, "degraded");
    assert.ok(connections >= 1, `expected at least one sse connection, saw ${connections}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

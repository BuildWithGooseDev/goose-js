// Integration tests against a stdlib http stub standing in for the config
// service. Exercises the real request path: snapshot load, polling deltas,
// canary evaluation, configs, and the embedded webhook listener.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GooseSDK } from "../dist/index.js";
import { flag, freePort, postWebhook, startStub } from "./helpers.mjs";

function newClient(baseUrl, extra = {}) {
  return new GooseSDK({
    clientId: "gsc_x",
    serverUrl: baseUrl,
    flagsets: "checkout",
    autoConnect: false,
    ...extra,
  });
}

test("snapshot loads typed flag values", async () => {
  const stub = await startStub();
  stub.state.flags = [
    flag("edge_ui", "bool", "true"),
    flag("max_retries", "number", "3"),
    flag("theme", "list_of_values", "grid"),
  ];
  const client = newClient(stub.baseUrl);
  try {
    await client.refresh();
    assert.equal(await client.getFlag("edge_ui"), true);
    assert.equal(await client.getFlag("max_retries"), 3);
    assert.equal(await client.getFlag("theme"), "grid");
    assert.equal(await client.getFlag("missing", { default: "fallback" }), "fallback");
  } finally {
    client.close();
    await stub.close();
  }
});

test("polling picks up a delta and notifies onChange", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("edge_ui", "bool", "false")];
  const client = newClient(stub.baseUrl);
  const changes = [];
  client.onChange((change) => changes.push(change));
  try {
    await client.refresh();
    assert.equal(await client.getFlag("edge_ui"), false);

    stub.state.flags = [flag("edge_ui", "bool", "true")];
    await client.refresh(); // initialized + polling => polls once
    assert.equal(await client.getFlag("edge_ui"), true);

    const change = changes.find((c) => c.flagKey === "edge_ui" && c.value === true);
    assert.ok(change, "onChange fired for edge_ui");
    assert.equal(change.previousValue, false);
  } finally {
    client.close();
    await stub.close();
  }
});

test("storageAdapter mirrors values on load and delta", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("edge_ui", "bool", "false")];
  const writes = [];
  const client = newClient(stub.baseUrl, {
    storageAdapter: { createOrUpdate: (fs, key, value) => writes.push([fs, key, value]) },
  });
  try {
    await client.refresh();
    stub.state.flags = [flag("edge_ui", "bool", "true")];
    await client.refresh();
    assert.deepEqual(writes.at(-1), ["checkout", "edge_ui", true]);
  } finally {
    client.close();
    await stub.close();
  }
});

test("background polling lifecycle via connect()", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("edge_ui", "bool", "false")];
  const client = newClient(stub.baseUrl, { connectionType: "polling", pollIntervalSeconds: 1 });
  try {
    await client.connect();
    assert.equal(await client.getFlag("edge_ui"), false);

    stub.state.flags = [flag("edge_ui", "bool", "true")];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await client.getFlag("edge_ui")) !== true) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await client.getFlag("edge_ui"), true);
  } finally {
    client.close();
    await stub.close();
  }
});

test("canary rollout buckets deterministically", async () => {
  const stub = await startStub();
  // user-123 buckets to 73 for (salt "s1", flag "new_checkout").
  stub.state.flags = [
    flag("new_checkout", "bool", "false", {
      rollout_percentage: 80,
      rollout_salt: "s1",
      rollout_value: "true",
    }),
  ];
  const client = newClient(stub.baseUrl);
  try {
    await client.refresh();
    // 73 < 80 -> in the canary cohort -> candidate value.
    assert.equal(await client.getFlag("new_checkout", { targetingKey: "user-123" }), true);

    stub.state.flags[0].rollout_percentage = 50; // below the user's bucket
    await client.refresh();
    assert.equal(await client.getFlag("new_checkout", { targetingKey: "user-123" }), false);

    // Without a targeting key the feature is never leaked -> baseline.
    assert.equal(await client.getFlag("new_checkout"), false);
  } finally {
    client.close();
    await stub.close();
  }
});

test("configs: seed silently, then fire listeners on change", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("edge_ui", "bool", "false")];
  stub.state.configs = {
    frontend: {
      document: { configs: { layout: { value: "grid", apply_strategy: "immediate" } } },
      revision_number: 1,
    },
  };
  const client = newClient(stub.baseUrl, {
    clientSecret: "sek",
    namespaceName: "production",
    configs: ["frontend"],
  });
  const events = [];
  client.on("frontend", (event) => events.push(event));
  try {
    await client.refresh(); // initial seed, no listeners
    assert.equal(client.getConfigValue("frontend", "layout"), "grid");
    assert.ok("frontend" in client.configsSnapshot());
    assert.equal(events.length, 0);

    stub.state.configs.frontend.document.configs.layout.value = "list";
    stub.state.configs.frontend.revision_number = 2;
    await client.refresh();

    assert.equal(events.length, 1);
    assert.equal(events[0].name, "frontend");
    assert.equal(events[0].applyStrategy, "immediate");
    assert.equal(events[0].newValue.configs.layout.value, "list");
    assert.equal(client.getConfigValue("frontend", "layout"), "list");
  } finally {
    client.close();
    await stub.close();
  }
});

test("config requires_restart fires the drain hook", async () => {
  const stub = await startStub();
  stub.state.configs = {
    database: {
      document: { configs: { url: { value: "a", apply_strategy: "requires_restart" } } },
      revision_number: 1,
    },
  };
  const client = newClient(stub.baseUrl, {
    clientSecret: "sek",
    namespaceName: "production",
    configs: ["database"],
  });
  const drains = [];
  client.onRestartRequired((event) => drains.push(event));
  try {
    await client.refresh();
    stub.state.configs.database.document.configs.url.value = "b";
    await client.refresh();
    assert.equal(drains.length, 1);
    assert.equal(drains[0].applyStrategy, "requires_restart");
  } finally {
    client.close();
    await stub.close();
  }
});

test("webhook registration and embedded listener round-trip", async () => {
  const stub = await startStub();
  stub.state.flags = [flag("edge_ui", "bool", "false")];
  const listenerPort = await freePort();
  const client = new GooseSDK({
    clientId: "gsc_x",
    clientSecret: "sek",
    serverUrl: stub.baseUrl,
    flagsets: "HookTest",
    connectionType: "webhook",
    webhookTargetUrl: `http://127.0.0.1:${listenerPort}/webhook`,
    webhookSecret: "shh",
    webhookListenerHost: "127.0.0.1",
    webhookListenerPort: listenerPort,
    autoConnect: false,
  });
  try {
    await client.connect();
    assert.equal(stub.state.webhookRegistrations.length, 1);
    assert.equal(stub.state.webhookRegistrations[0].flagset, "HookTest");
    assert.equal(stub.state.webhookRegistrations[0].client_secret, "sek");

    const ok = await postWebhook(
      client.webhookListenerUrl,
      { flagSet: "HookTest", flagKey: "edge_ui", flagValue: "true", eventId: "e1" },
      "shh",
    );
    assert.equal(ok, 200);
    assert.equal(await client.getFlag("edge_ui", { flagset: "HookTest" }), true);
    assert.equal(client.webhookEventsReceived, 1);

    // Redelivery of the same eventId is deduped (not reapplied).
    await postWebhook(
      client.webhookListenerUrl,
      { flagSet: "HookTest", flagKey: "edge_ui", flagValue: "false", eventId: "e1" },
      "shh",
    );
    assert.equal(await client.getFlag("edge_ui", { flagset: "HookTest" }), true);
    assert.equal(client.webhookEventsReceived, 2);

    // Wrong secret is rejected.
    const bad = await postWebhook(
      client.webhookListenerUrl,
      { flagSet: "HookTest", flagKey: "edge_ui", flagValue: "false", eventId: "e2" },
      "wrong",
    );
    assert.equal(bad, 401);
  } finally {
    client.close();
    await stub.close();
  }
});

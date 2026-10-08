// Constructor validation — pure, no network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GooseSDK, GooseSDKError, createClient } from "../dist/index.js";

const base = {
  clientId: "gsc_x",
  serverUrl: "http://localhost:8080",
  flagsets: "default",
  autoConnect: false,
};

function expectThrow(options, label) {
  assert.throws(() => new GooseSDK(options), GooseSDKError, label);
}

test("requires clientId and serverUrl", () => {
  expectThrow({ ...base, clientId: "  " }, "missing clientId");
  expectThrow({ ...base, serverUrl: "" }, "missing serverUrl");
});

test("requires at least one flagset", () => {
  expectThrow({ ...base, flagsets: [] }, "no flagsets");
  expectThrow({ ...base, flagsets: ["", "  "] }, "blank flagsets");
});

test("configs require namespace and secret", () => {
  expectThrow({ ...base, clientSecret: "sek", configs: ["frontend"] }, "configs without namespace");
  expectThrow({ ...base, namespaceName: "prod", configs: ["frontend"] }, "configs without secret");
});

test("webhook requires target url and secret", () => {
  expectThrow({ ...base, clientSecret: "sek", connectionType: "webhook" }, "webhook without target");
  expectThrow(
    { ...base, clientSecret: "sek", connectionType: "webhook", webhookTargetUrl: "/relative" },
    "webhook with relative target",
  );
  expectThrow(
    { ...base, connectionType: "webhook", webhookTargetUrl: "http://h:8091/webhook" },
    "webhook without secret",
  );
});

test("unknown connection type is rejected", () => {
  expectThrow({ ...base, connectionType: "carrier-pigeon" }, "bad connection type");
});

test("flagsetNamespaces rejects an unknown flagset", () => {
  expectThrow({ ...base, flagsetNamespaces: { other: "ns" } }, "unknown flagset namespace");
});

test("flag-only client constructs with just a client id", () => {
  const client = new GooseSDK(base);
  assert.deepEqual(client.flagsets, ["default"]);
  assert.ok(client instanceof GooseSDK);
});

test("createClient is a constructor alias", () => {
  const client = createClient(base);
  assert.ok(client instanceof GooseSDK);
});

test("webhook listener path is derived from the target url", () => {
  const client = new GooseSDK({
    ...base,
    clientSecret: "sek",
    connectionType: "webhook",
    webhookTargetUrl: "http://127.0.0.1:8091/hooks/incoming",
    autoConnect: false,
  });
  assert.equal(client.webhookListenerUrl, "http://0.0.0.0:8091/hooks/incoming");
});

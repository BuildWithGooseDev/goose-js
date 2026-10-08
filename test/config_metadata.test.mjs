// Config entry metadata — app-version gating, defaults, deprecation, sensitive
// values. Pure, no network: documents are seeded straight into the client.
import { test } from "node:test";
import assert from "node:assert/strict";

import { GooseSDK } from "../dist/index.js";

const base = {
  clientId: "gsc_x",
  clientSecret: "sek",
  serverUrl: "http://localhost:8080",
  flagsets: "default",
  namespaceName: "production",
  configs: ["frontend"],
  autoConnect: false,
};

function configClient(overrides = {}) {
  const client = new GooseSDK({ ...base, ...overrides });
  client.configs.set("frontend", {
    document: {
      configs: {
        layout: { value: "grid-v2", default: "grid", min_app_version: "2.4.0" },
        no_default: { value: "on", min_app_version: "2.4.0" },
        ungated: { value: "always" },
      },
    },
    revision: 1,
  });
  return client;
}

// Capture console.warn for the duration of fn.
function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("app-version bounds are inclusive on both ends", () => {
  const cases = [
    ["2.3.9", "grid"],
    ["2.4.0", "grid-v2"], // lower bound is inclusive
    ["2.7.1", "grid-v2"],
  ];
  for (const [appVersion, expected] of cases) {
    const client = configClient({ appVersion });
    assert.equal(client.getConfigValue("frontend", "layout"), expected, `appVersion ${appVersion}`);
  }
});

test("a gated-out entry resolves to its default, then to the caller's fallback", () => {
  const client = configClient({ appVersion: "2.1.0" });
  assert.equal(client.getConfigValue("frontend", "layout", "caller-fallback"), "grid");
  assert.equal(client.getConfigValue("frontend", "no_default", "caller-fallback"), "caller-fallback");
  assert.equal(client.getConfigValue("frontend", "ungated"), "always");
});

test("a client with no appVersion ignores bounds entirely", () => {
  const client = configClient();
  assert.equal(client.getConfigValue("frontend", "layout"), "grid-v2");
});

test("an unparseable appVersion disables gating rather than hiding values", () => {
  let client;
  const warnings = captureWarnings(() => {
    client = configClient({ appVersion: "nightly" });
  });
  assert.equal(client.appVersion, null);
  assert.equal(client.getConfigValue("frontend", "layout"), "grid-v2");
  assert.ok(
    warnings.some((w) => w.includes("unparseable appVersion")),
    "expected a warning about the unparseable appVersion",
  );
});

test("a deprecated entry warns once, naming its replacement", () => {
  const client = configClient();
  client.configs.get("frontend").document.configs.old_key = {
    value: "x",
    deprecated: true,
    replaced_by: "new_key",
  };
  const warnings = captureWarnings(() => {
    client.getConfigValue("frontend", "old_key");
    client.getConfigValue("frontend", "old_key");
  });
  const deprecations = warnings.filter((w) => w.includes("deprecated"));
  assert.equal(deprecations.length, 1, "deprecation should warn once, not per read");
  assert.ok(deprecations[0].includes("new_key"), "warning should name replaced_by");
});

test("a requires_restart change to a gated-out entry does not restart the process", () => {
  const client = configClient({ appVersion: "2.4.0" });
  const oldDoc = {
    configs: {
      future: { value: "a", apply_strategy: "requires_restart", min_app_version: "9.0.0" },
      here: { value: "a", apply_strategy: "immediate" },
    },
  };
  const newDoc = {
    configs: {
      future: { value: "b", apply_strategy: "requires_restart", min_app_version: "9.0.0" },
      here: { value: "b", apply_strategy: "immediate" },
    },
  };
  assert.deepEqual(client.changedConfigEntries(oldDoc, newDoc), ["immediate"]);

  // Without an appVersion the pre-gating behaviour is preserved: both change.
  const ungated = configClient();
  assert.equal(ungated.changedConfigEntries(oldDoc, newDoc).length, 2);
});

test("sensitive values are kept out of the persisted snapshot", () => {
  const client = configClient();
  client.configs.set("secrets", {
    document: {
      configs: {
        db_url: {
          value: "postgres://app:hunter2@db",
          default: "postgres://localhost",
          sensitive: true,
          apply_strategy: "requires_restart",
        },
        layout: { value: "grid", apply_strategy: "immediate" },
      },
    },
    revision: 1,
  });

  const persisted = client.buildSnapshot().configs.secrets.document.configs;
  assert.equal("value" in persisted.db_url, false, "sensitive value was persisted");
  assert.equal("default" in persisted.db_url, false, "sensitive default was persisted");
  assert.equal(persisted.db_url.apply_strategy, "requires_restart", "other metadata should survive");
  assert.equal(persisted.layout.value, "grid", "non-sensitive entry must be untouched");

  // The live document must not be mutated by building a snapshot of it.
  assert.equal(
    client.configs.get("secrets").document.configs.db_url.value,
    "postgres://app:hunter2@db",
  );
});

test("a required entry that resolves to nothing is reported through onError", () => {
  const errors = [];
  const client = new GooseSDK({ ...base, appVersion: "2.1.0", onError: (e) => errors.push(e) });
  client.applyConfigs(
    {
      frontend: {
        document: {
          configs: {
            gated_bare: { value: "x", required: true, min_app_version: "9.0.0" },
            gated_default: { value: "x", default: "y", required: true, min_app_version: "9.0.0" },
          },
        },
        revision_number: 1,
      },
    },
    true,
  );
  assert.equal(errors.length, 1, "expected exactly one unsatisfied-required error");
  assert.match(errors[0].message, /gated_bare/);
  assert.doesNotMatch(errors[0].message, /gated_default/, "an entry with a default is satisfied");
});

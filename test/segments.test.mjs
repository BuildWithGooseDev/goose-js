// Segment targeting. The vector assertions read the same
// tests/fixtures/segment_vectors.json the server and the other SDKs read, so
// an audience cannot mean one thing in a browser and another on the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GooseSDK } from "../dist/index.js";
import { matchesSegment, conditionMatches, attributeString } from "../dist/segments.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "tests", "fixtures", "segment_vectors.json"), "utf8"),
);

test("segment match vectors", () => {
  assert.ok(vectors.matches.length > 0);
  for (const c of vectors.matches) {
    assert.equal(
      matchesSegment(vectors.segments[c.segment], vectors.contexts[c.context]),
      c.matches,
      `${c.segment} against ${c.context}`,
    );
  }
});

test("attribute string vectors", () => {
  for (const c of vectors.attribute_strings) {
    assert.equal(attributeString(c.value), c.string, `attributeString(${JSON.stringify(c.value)})`);
  }
});

test("an empty segment matches nobody", () => {
  const context = { plan: "enterprise" };
  assert.equal(matchesSegment({ rules: [] }, context), false);
  assert.equal(matchesSegment({ rules: [{ conditions: [] }] }, context), false);
});

// The subtle rule: a negative condition against a missing attribute is false,
// not true. Otherwise `plan != enterprise` quietly includes every subject
// whose context omitted `plan` — during a rollout, most of them.
test("a missing attribute fails every operator except not_exists", () => {
  for (const operator of vectors.operators) {
    const condition = { attribute: "plan", operator, values: ["enterprise"] };
    assert.equal(
      conditionMatches(condition, {}),
      operator === "not_exists",
      `operator ${operator}`,
    );
  }
});

test("an explicit null is treated as absent", () => {
  assert.equal(conditionMatches({ attribute: "p", operator: "exists", values: [] }, { p: null }), false);
  assert.equal(conditionMatches({ attribute: "p", operator: "not_exists", values: [] }, { p: null }), true);
});

test("numeric comparison is not lexicographic", () => {
  const condition = { attribute: "seats", operator: "lt", values: ["10"] };
  assert.equal(conditionMatches(condition, { seats: 9 }), true);
  assert.equal(conditionMatches(condition, { seats: "many" }), false);
});

test("version comparison is not lexicographic", () => {
  const condition = { attribute: "v", operator: "version_gt", values: ["2.9.0"] };
  assert.equal(conditionMatches(condition, { v: "2.10.0" }), true);
  assert.equal(conditionMatches(condition, { v: "nonsense" }), false);
});

test("a list attribute matches any element", () => {
  const context = { roles: ["billing", "admin"] };
  assert.equal(conditionMatches({ attribute: "roles", operator: "in", values: ["admin", "owner"] }, context), true);
  assert.equal(conditionMatches({ attribute: "roles", operator: "not_in", values: ["admin"] }, context), false);
});

test("an unknown operator never matches", () => {
  assert.equal(
    conditionMatches({ attribute: "plan", operator: "regex_match", values: [".*"] }, { plan: "enterprise" }),
    false,
  );
});

const base = {
  clientId: "gsc_x",
  serverUrl: "http://localhost:8080",
  flagsets: "default",
  autoConnect: false,
};

const ENTERPRISE_RULES =
  '{"rules":[{"conditions":[{"attribute":"plan","operator":"equals","values":["enterprise"]}]}]}';

test("getFlag serves the segment value to a matching context", async () => {
  const client = new GooseSDK(base);
  client.applySnapshot("default", [{
    flag_key: "new_checkout",
    flag_data_type: "bool",
    flag_value: false,
    segment_key: "enterprise",
    segment_value: true,
    segment_definition: ENTERPRISE_RULES,
  }]);

  assert.equal(await client.getFlag("new_checkout", { context: { plan: "enterprise" } }), true);
  assert.equal(await client.getFlag("new_checkout", { context: { plan: "free" } }), false);
  // A caller that has not adopted targeting keeps working.
  assert.equal(await client.getFlag("new_checkout"), false);
});

// Being in the audience is about who you are; a canary is about what fraction
// of traffic sees something. A segment hit wins outright.
test("segment targeting wins over a canary", async () => {
  const client = new GooseSDK({ ...base, defaultTargetingKey: "user-123" });
  client.applySnapshot("default", [{
    flag_key: "f",
    flag_data_type: "bool",
    flag_value: false,
    segment_key: "enterprise",
    segment_value: true,
    segment_definition: ENTERPRISE_RULES,
    rollout_percentage: 0,
    rollout_salt: "s1",
    rollout_value: true,
  }]);

  assert.equal(await client.getFlag("f", { context: { plan: "enterprise" } }), true);
});

test("targeting is cleared when removed server-side", async () => {
  const client = new GooseSDK(base);
  client.applySnapshot("default", [{
    flag_key: "f", flag_data_type: "bool", flag_value: false,
    segment_key: "s", segment_value: true, segment_definition: ENTERPRISE_RULES,
  }]);
  assert.equal(await client.getFlag("f", { context: { plan: "enterprise" } }), true);

  client.applySnapshot("default", [{ flag_key: "f", flag_data_type: "bool", flag_value: false }]);
  assert.equal(await client.getFlag("f", { context: { plan: "enterprise" } }), false);
});

// Corrupt rules mean the flag is served untargeted, not that the read fails.
test("an unparseable segment definition falls back to the baseline", async () => {
  const client = new GooseSDK(base);
  client.applySnapshot("default", [{
    flag_key: "f", flag_data_type: "bool", flag_value: false,
    segment_key: "s", segment_value: true, segment_definition: "{not json",
  }]);
  assert.equal(await client.getFlag("f", { context: { plan: "enterprise" } }), false);
});

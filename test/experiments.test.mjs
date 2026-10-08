// Experiment bucketing and reporting. The vector assertions read the same
// tests/fixtures/experiment_vectors.json the server reads, so bucketing cannot
// drift between the browser SDK and the service that recomputes assignments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { GooseSDK } from "../dist/index.js";
import {
  bucketSubject,
  assignVariant,
  isEligible,
  EXPERIMENT_BUCKET_SLOTS,
} from "../dist/experiments.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "..", "tests", "fixtures", "experiment_vectors.json"), "utf8"),
);

function definitionFor(name) {
  const placement = vectors.placements[name];
  return {
    experiment_key: placement.experiment_key,
    salt: placement.salt,
    traffic_allocation:
      placement.traffic_allocation ?? EXPERIMENT_BUCKET_SLOTS,
    layer_key: placement.layer_key ?? null,
    layer_salt: placement.layer_salt ?? null,
    layer_slot_start: placement.layer_slot_start ?? null,
    layer_slot_end: placement.layer_slot_end ?? null,
    variants: placement.variants,
    metric_keys: [],
  };
}

test("slot count matches the shared contract", () => {
  assert.equal(vectors.slots, EXPERIMENT_BUCKET_SLOTS);
});

test("bucketSubject matches the shared vectors", async () => {
  assert.ok(vectors.bucket_subject.length > 0);
  for (const v of vectors.bucket_subject) {
    const got = await bucketSubject(v.salt, v.key, v.subject);
    assert.equal(got, v.bucket, `bucketSubject(${v.salt},${v.key},${v.subject})`);
  }
});

// Experiments must use the same hash as the flag canary, differing only in
// modulus — mod 100 is the value the existing flag vectors already pin.
test("experiment bucketing shares the flag hash", async () => {
  for (const v of vectors.bucket_subject) {
    const got = await bucketSubject(v.salt, v.key, v.subject);
    assert.equal(got % 100, v.bucket_mod_100, `mod-100 reduction for ${v.subject}`);
  }
});

test("assignVariant matches the shared vectors", async () => {
  assert.ok(vectors.assignments.length > 0);
  for (const v of vectors.assignments) {
    const definition = definitionFor(v.placement);
    assert.equal(
      await isEligible(definition, v.subject),
      v.eligible,
      `${v.placement}/${v.subject} eligibility`,
    );
    assert.equal(
      await assignVariant(definition, v.subject),
      v.variant,
      `${v.placement}/${v.subject} variant`,
    );
  }
});

const base = {
  clientId: "gsc_x",
  serverUrl: "http://localhost:8080",
  flagsets: "default",
  namespaceName: "production",
  enableExperiments: true,
  autoConnect: false,
};

function seeded(overrides = {}, experiments = undefined) {
  const client = new GooseSDK({ ...base, ...overrides });
  client.applyExperiments({
    experiments: experiments ?? {
      checkout: {
        experiment_key: "checkout",
        status: "running",
        salt: "s1",
        traffic_allocation: EXPERIMENT_BUCKET_SLOTS,
        variants: [
          { variant_key: "control", weight_bp: 10000, payload: { layout: "a" }, is_control: true, sort_order: 0 },
          { variant_key: "treatment", weight_bp: 0, payload: { layout: "b" }, is_control: false, sort_order: 1 },
        ],
        metric_keys: ["purchase", "revenue"],
      },
    },
  });
  return client;
}

test("experiments require a namespace", () => {
  assert.throws(
    () => new GooseSDK({ ...base, namespaceName: undefined }),
    /namespaceName is required when experiments are enabled/,
  );
});

test("a browser client needs no secret for experiments", () => {
  // configs would throw here; experiments must not, or the browser build can
  // never use them.
  assert.doesNotThrow(() => new GooseSDK({ ...base }));
});

test("getVariant without a targeting key returns no assignment", async () => {
  const client = seeded();
  const got = await client.getVariant("checkout");
  assert.equal(got.inExperiment, false);
  assert.equal(got.reason, "no_targeting_key");
});

// "Not fetched yet" and "no such experiment" are different problems; conflating
// them sends people hunting for a typo that is not there.
test("getVariant distinguishes not-loaded from unknown", async () => {
  const fresh = new GooseSDK({ ...base, defaultTargetingKey: "user-123" });
  assert.equal((await fresh.getVariant("checkout")).reason, "not_loaded");

  fresh.applyExperiments({ experiments: {} });
  assert.equal((await fresh.getVariant("checkout")).reason, "unknown_experiment");
});

test("getVariant returns the arm and its payload", async () => {
  const client = seeded({ defaultTargetingKey: "user-123" });
  const got = await client.getVariant("checkout");
  assert.equal(got.inExperiment, true);
  assert.equal(got.key, "control");
  assert.deepEqual(got.payload, { layout: "a" });
});

test("a stopped experiment serves its pinned winner to everyone", async () => {
  const client = seeded({ defaultTargetingKey: "user-123" }, {
    checkout: {
      experiment_key: "checkout",
      status: "stopped",
      salt: "s1",
      traffic_allocation: 0, // would normally exclude everyone
      winner_variant_key: "treatment",
      variants: [
        { variant_key: "control", weight_bp: 5000, payload: {}, is_control: true, sort_order: 0 },
        { variant_key: "treatment", weight_bp: 5000, payload: { v: 2 }, is_control: false, sort_order: 1 },
      ],
      metric_keys: [],
    },
  });

  for (const subject of ["user-1", "user-2", "user-3"]) {
    const got = await client.getVariant("checkout", subject);
    assert.equal(got.key, "treatment", `${subject} should get the pinned winner`);
    assert.equal(got.inExperiment, true);
  }
});

test("exposure is reported once per subject", async () => {
  const client = seeded();
  for (let i = 0; i < 20; i += 1) {
    await client.getVariant("checkout", "user-123");
  }
  await client.getVariant("checkout", "user-456");

  const queued = client.experimentEvents.pending.filter((e) => e.type === "exposure");
  assert.equal(queued.length, 2, "one exposure per distinct subject");
});

// A paused experiment keeps serving so traffic does not flip while it is
// parked, but it must stop collecting.
test("a paused experiment serves but does not collect", async () => {
  const client = seeded({ defaultTargetingKey: "user-123" }, {
    checkout: {
      experiment_key: "checkout",
      status: "paused",
      salt: "s1",
      traffic_allocation: EXPERIMENT_BUCKET_SLOTS,
      variants: [
        { variant_key: "control", weight_bp: 10000, payload: {}, is_control: true, sort_order: 0 },
        { variant_key: "treatment", weight_bp: 0, payload: {}, is_control: false, sort_order: 1 },
      ],
      metric_keys: ["purchase"],
    },
  });

  const got = await client.getVariant("checkout");
  assert.equal(got.inExperiment, true, "a paused experiment should still serve an arm");
  assert.equal(client.experimentEvents.pending.length, 0, "and collect nothing");

  client.trackConversion("purchase");
  assert.equal(client.experimentEvents.pending.length, 0, "including conversions");
});

test("conversions reach every experiment declaring the metric", async () => {
  const client = seeded({ defaultTargetingKey: "user-123" }, {
    checkout: {
      experiment_key: "checkout", status: "running", salt: "s1",
      traffic_allocation: EXPERIMENT_BUCKET_SLOTS, metric_keys: ["purchase"],
      variants: [{ variant_key: "control", weight_bp: 10000, payload: {}, is_control: true, sort_order: 0 }],
    },
    search: {
      experiment_key: "search", status: "running", salt: "s2",
      traffic_allocation: EXPERIMENT_BUCKET_SLOTS, metric_keys: ["purchase", "clicked"],
      variants: [{ variant_key: "control", weight_bp: 10000, payload: {}, is_control: true, sort_order: 0 }],
    },
    unrelated: {
      experiment_key: "unrelated", status: "running", salt: "s3",
      traffic_allocation: EXPERIMENT_BUCKET_SLOTS, metric_keys: ["signup"],
      variants: [{ variant_key: "control", weight_bp: 10000, payload: {}, is_control: true, sort_order: 0 }],
    },
  });

  client.trackConversion("purchase");
  const conversions = client.experimentEvents.pending.filter((e) => e.type === "conversion");
  assert.equal(conversions.length, 2);
  assert.ok(!conversions.some((e) => e.experiment_key === "unrelated"));
  assert.ok(conversions.every((e) => e.value === 1));
});

test("trackMetric carries its value and can be scoped to one experiment", async () => {
  const client = seeded({ defaultTargetingKey: "user-123" });
  client.trackMetric("revenue", 42.5, { experimentKey: "checkout" });

  const conversions = client.experimentEvents.pending.filter((e) => e.type === "conversion");
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].value, 42.5);
  assert.equal(conversions[0].metric_key, "revenue");
});

// Dropping a buffered exposure must forget its dedup key, or that subject is
// erased from the denominator for the life of the page.
test("a dropped exposure is reported again", async () => {
  const client = seeded();

  // Fill the queue to capacity directly: going through enqueue would trip the
  // size-based auto-flush and fire real requests at a server that is not there.
  client.experimentEvents.queue = Array.from({ length: 1000 }, (_, i) => ({
    event_id: `filler-${i}`, type: "exposure", experiment_key: "x",
    targeting_key: "x", occurred_at: new Date().toISOString(),
  }));

  await client.getVariant("checkout", "user-123");
  assert.ok(client.droppedExperimentEvents() > 0, "the exposure should be counted as dropped");

  // Drain and retry: the subject must be reported, not suppressed.
  client.experimentEvents.queue = [];
  await client.getVariant("checkout", "user-123");
  const requeued = client.experimentEvents.pending.filter(
    (e) => e.type === "exposure" && e.targeting_key === "user-123",
  );
  assert.equal(requeued.length, 1, "the subject should be re-reported after a drop");
});

/**
 * Experiment assignment, for the browser.
 *
 * Assignment is computed locally and deterministically from the targeting key —
 * there is no per-user server call, so `getVariant` costs a hash rather than a
 * round trip and keeps working from cache while the network is down.
 *
 * The hash must match `utils/bucketing.go` on the server byte for byte. Both are
 * checked against `tests/fixtures/experiment_vectors.json`, and the server
 * independently recomputes every reported assignment, so a drift shows up as a
 * mismatch rate in the dashboard rather than as silently corrupted results.
 */

/** Bucketing resolution: slots run [0, 10000). */
export const EXPERIMENT_BUCKET_SLOTS = 10000;

/** Why a `getVariant` call did or did not produce an assignment. */
export type VariantReason =
  | "assigned"
  | "not_eligible"
  | "no_targeting_key"
  | "unknown_experiment"
  | "not_loaded";

/** One arm, as delivered by config_service. */
export interface ExperimentVariant {
  variant_key: string;
  weight_bp: number;
  payload: unknown;
  is_control: boolean;
  sort_order: number;
}

/** One experiment, as delivered by config_service. */
export interface ExperimentDefinition {
  experiment_key: string;
  status: string;
  salt: string;
  traffic_allocation: number;
  layer_key?: string | null;
  layer_salt?: string | null;
  layer_slot_start?: number | null;
  layer_slot_end?: number | null;
  winner_variant_key?: string | null;
  variants: ExperimentVariant[];
  metric_keys: string[];
  updated_at?: string;
}

/**
 * The outcome of an assignment. `inExperiment` is false when the subject is not
 * in the experiment at all — `key` is then null and the caller should use its
 * own default. `reason` says why.
 */
export interface Variant {
  key: string | null;
  payload: unknown;
  inExperiment: boolean;
  reason: VariantReason;
}

/** An experiment that is parked: it still serves arms but collects nothing. */
export const EXPERIMENT_STATUS_PAUSED = "paused";

/**
 * Map a subject to a slot in [0, EXPERIMENT_BUCKET_SLOTS) by hashing
 * `salt:key:subject` with SHA-256 and reducing the first 8 digest bytes,
 * big-endian.
 *
 * Same hash as the flag canary's `bucketUser`; only the modulus differs. The
 * 64-bit reduction uses modular arithmetic to stay exact without BigInt — the
 * largest intermediate is 9999 * 256 + 255 = 2_559_999, comfortably inside the
 * exact-integer range of a double.
 */
export async function bucketSubject(
  salt: string,
  key: string,
  subject: string,
): Promise<number> {
  const data = new TextEncoder().encode(`${salt}:${key}:${subject}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let bucket = 0;
  for (let i = 0; i < 8; i++) {
    bucket = (bucket * 256 + digest[i]) % EXPERIMENT_BUCKET_SLOTS;
  }
  return bucket;
}

function inLayer(definition: ExperimentDefinition): boolean {
  return Boolean(
    definition.layer_key &&
      definition.layer_salt &&
      definition.layer_slot_start !== null &&
      definition.layer_slot_start !== undefined &&
      definition.layer_slot_end !== null &&
      definition.layer_slot_end !== undefined,
  );
}

/**
 * Decide whether a subject is in the experiment at all.
 *
 * Inside a layer the slot comes from the layer's salt and key, so every
 * experiment in that layer sees the subject at the same slot and their disjoint
 * ranges make membership mutually exclusive. Outside a layer the draw uses the
 * experiment's own salt with an `alloc:` prefix, which keeps eligibility
 * statistically independent of the variant draw despite sharing a salt.
 */
export async function isEligible(
  definition: ExperimentDefinition,
  subject: string,
): Promise<boolean> {
  if (inLayer(definition)) {
    const slot = await bucketSubject(definition.layer_salt as string, definition.layer_key as string, subject);
    return slot >= (definition.layer_slot_start as number) && slot < (definition.layer_slot_end as number);
  }
  const allocation = definition.traffic_allocation ?? EXPERIMENT_BUCKET_SLOTS;
  if (allocation >= EXPERIMENT_BUCKET_SLOTS) {
    return true;
  }
  if (allocation <= 0) {
    return false;
  }
  const draw = await bucketSubject(definition.salt, `alloc:${definition.experiment_key}`, subject);
  return draw < allocation;
}

/**
 * Walk the variants in sort order, accumulating weights, and return the first
 * whose running total exceeds the subject's draw. The walk order is why adding
 * a variant at the end does not reshuffle subjects already assigned to earlier
 * ones. Returns null when the subject is not eligible or no arm carries weight.
 */
export async function assignVariant(
  definition: ExperimentDefinition,
  subject: string,
): Promise<string | null> {
  if (!(await isEligible(definition, subject))) {
    return null;
  }

  const ordered = [...(definition.variants ?? [])].sort((a, b) => {
    if (a.sort_order !== b.sort_order) {
      return a.sort_order - b.sort_order;
    }
    // Tiebreak on key so independent implementations cannot disagree if sort
    // orders are ever equal.
    return a.variant_key < b.variant_key ? -1 : a.variant_key > b.variant_key ? 1 : 0;
  });

  const total = ordered.reduce((sum, v) => sum + v.weight_bp, 0);
  if (total <= 0) {
    return null;
  }

  let draw = await bucketSubject(definition.salt, definition.experiment_key, subject);
  if (total !== EXPERIMENT_BUCKET_SLOTS) {
    // Defensive: weights are validated to sum to the full space on write, but a
    // hand-edited definition must not push the draw past the last variant.
    draw = Math.floor((draw * total) / EXPERIMENT_BUCKET_SLOTS);
  }

  let cumulative = 0;
  for (const variant of ordered) {
    cumulative += variant.weight_bp;
    if (draw < cumulative) {
      return variant.variant_key;
    }
  }
  return ordered[ordered.length - 1].variant_key;
}

/** Find a variant's payload by key. */
export function variantPayload(
  definition: ExperimentDefinition,
  variantKey: string,
): unknown {
  for (const variant of definition.variants ?? []) {
    if (variant.variant_key === variantKey) {
      return variant.payload;
    }
  }
  return undefined;
}

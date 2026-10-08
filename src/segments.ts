/**
 * Segment evaluation — a port of `utils/segments.go` on the server.
 *
 * A segment answers "is this subject in this audience", from attributes the
 * caller supplies. Evaluated here rather than server-side because only the
 * caller has the attributes, and a flag read must not cost a round trip.
 *
 * Checked against `tests/fixtures/segment_vectors.json`, the same file the
 * server and the other SDKs read. There is deliberately no regex operator: a
 * pattern that backtracks badly would be a denial of service, and across three
 * regex engines it would not even fail the same way.
 */

export interface SegmentCondition {
  attribute: string;
  operator: string;
  values?: string[];
}

export interface SegmentRule {
  conditions: SegmentCondition[];
}

export interface SegmentDefinition {
  rules: SegmentRule[];
}

/**
 * The attribute bag used for segment targeting. Separate from the targeting
 * key: the key decides which side of a canary a subject lands on, the context
 * decides whether they are in the audience at all.
 */
export type EvaluationContext = Record<string, unknown>;

/** The segment override delivered alongside a flag value. */
export interface SegmentTargeting {
  key: string;
  value: unknown;
  definition: SegmentDefinition;
}

/**
 * Canonical string form of an attribute value.
 *
 * Pinned explicitly because default number formatting differs between Go,
 * Python and JavaScript, and a segment that matches in one SDK but not another
 * is exactly the failure the shared vectors exist to prevent. An integral
 * number renders "42", never "42.0".
 */
export function attributeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function attributeNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Lenient dotted version parse, matching the config app-version gating. */
export function parseSegmentVersion(raw: string): number[] | null {
  let trimmed = raw.trim().replace(/^v/, "");
  const suffix = trimmed.search(/[-+]/);
  if (suffix >= 0) trimmed = trimmed.slice(0, suffix);
  trimmed = trimmed.trim();
  if (trimmed.length === 0) return null;
  const components: number[] = [];
  for (const part of trimmed.split(".")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 0) return null;
    components.push(n);
  }
  return components;
}

function compareSegmentVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Apply a predicate; a list attribute matches when any element does. */
function anyAttributeString(raw: unknown, predicate: (s: string) => boolean): boolean {
  if (Array.isArray(raw)) {
    return raw.some((item) => predicate(attributeString(item)));
  }
  return predicate(attributeString(raw));
}

/**
 * Evaluate one condition.
 *
 * A missing attribute makes every operator false except `not_exists`. In
 * particular `not_equals` is false, not true: the vacuous reading would make a
 * negative condition silently match every subject whose context omitted the
 * attribute, which during a rollout is usually most of them.
 */
export function conditionMatches(
  condition: SegmentCondition,
  context: EvaluationContext,
): boolean {
  const values = condition.values ?? [];
  const raw = context[condition.attribute];
  const present =
    Object.prototype.hasOwnProperty.call(context, condition.attribute) &&
    raw !== null &&
    raw !== undefined;

  if (condition.operator === "exists") return present;
  if (condition.operator === "not_exists") return !present;
  if (!present) return false;

  const operand = values.length > 0 ? values[0] : "";

  switch (condition.operator) {
    case "equals":
      return anyAttributeString(raw, (s) => s === operand);
    case "not_equals":
      return !anyAttributeString(raw, (s) => s === operand);
    case "contains":
      return anyAttributeString(raw, (s) => s.includes(operand));
    case "starts_with":
      return anyAttributeString(raw, (s) => s.startsWith(operand));
    case "ends_with":
      return anyAttributeString(raw, (s) => s.endsWith(operand));
    case "in":
      return anyAttributeString(raw, (s) => values.includes(s));
    case "not_in":
      return !anyAttributeString(raw, (s) => values.includes(s));

    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const left = attributeNumber(raw);
      if (left === null) return false;
      const right = Number(operand.trim());
      if (!Number.isFinite(right) || operand.trim() === "") return false;
      if (condition.operator === "gt") return left > right;
      if (condition.operator === "gte") return left >= right;
      if (condition.operator === "lt") return left < right;
      return left <= right;
    }

    case "version_gt":
    case "version_gte":
    case "version_lt":
    case "version_lte": {
      const left = parseSegmentVersion(attributeString(raw));
      const right = parseSegmentVersion(operand);
      if (left === null || right === null) return false;
      const comparison = compareSegmentVersions(left, right);
      if (condition.operator === "version_gt") return comparison > 0;
      if (condition.operator === "version_gte") return comparison >= 0;
      if (condition.operator === "version_lt") return comparison < 0;
      return comparison <= 0;
    }
  }

  // An operator this SDK does not know must never match: a definition from a
  // newer dashboard must not accidentally include everyone.
  return false;
}

/**
 * Whether the context satisfies the segment. Rules are OR'd, conditions within
 * a rule are AND'd. An empty definition matches nobody — an unfinished
 * audience must not become a full rollout.
 */
export function matchesSegment(
  definition: SegmentDefinition,
  context: EvaluationContext,
): boolean {
  const rules = definition?.rules ?? [];
  if (rules.length === 0) return false;
  for (const rule of rules) {
    const conditions = rule?.conditions ?? [];
    if (conditions.length === 0) continue;
    if (conditions.every((condition) => conditionMatches(condition, context))) {
      return true;
    }
  }
  return false;
}

/**
 * Read the segment override off a flag payload. Returns null when the flag is
 * not targeted, or when the rules are unparseable — in which case the flag is
 * served untargeted rather than not at all, since losing an override is far
 * less harmful than failing the read.
 */
export function parseSegmentTargeting(raw: Record<string, unknown>): SegmentTargeting | null {
  const key = String(raw["segment_key"] ?? raw["segmentKey"] ?? "").trim();
  if (key === "") return null;

  const encoded = raw["segment_definition"] ?? raw["segmentDefinition"];
  if (encoded === null || encoded === undefined || String(encoded).trim() === "") return null;

  let definition: unknown;
  if (typeof encoded === "string") {
    try {
      definition = JSON.parse(encoded);
    } catch {
      return null;
    }
  } else {
    definition = encoded;
  }
  if (!definition || typeof definition !== "object") return null;

  return {
    key,
    value: raw["segment_value"] ?? raw["segmentValue"],
    definition: definition as SegmentDefinition,
  };
}

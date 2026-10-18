export {
  SERVER_URL,
  GooseSDK,
  GooseSDKError,
  GooseSDKHTTPError,
  createClient,
} from "./client.js";

export { FileCache } from "./cache.js";

export {
  matchesSegment,
  conditionMatches,
  attributeString,
} from "./segments.js";

export type {
  SegmentDefinition,
  SegmentCondition,
  SegmentRule,
  SegmentTargeting,
  EvaluationContext,
} from "./segments.js";

export {
  bucketSubject,
  assignVariant,
  isEligible,
  EXPERIMENT_BUCKET_SLOTS,
} from "./experiments.js";

export type {
  ConnectionState,
  ConnectionType,
  ConfigDocument,
  ConfigChangeEvent,
  ConfigChangeListener,
  ErrorListener,
  FlagValue,
  FlagChange,
  FlagChangeListener,
  GetFlagOptions,
  GooseClientOptions,
  StateChangeListener,
  StorageAdapter,
  TrackOptions,
} from "./client.js";

export type {
  ExperimentDefinition,
  ExperimentVariant,
  Variant,
  VariantReason,
} from "./experiments.js";

export type { PersistentCache, Snapshot } from "./cache.js";

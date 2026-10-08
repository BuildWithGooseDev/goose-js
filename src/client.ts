import type { ConfigSnapshot, PersistentCache, Snapshot } from "./cache.js";
import {
  matchesSegment,
  parseSegmentTargeting,
  type EvaluationContext,
  type SegmentTargeting,
} from "./segments.js";
import {
  assignVariant,
  EXPERIMENT_STATUS_PAUSED,
  variantPayload,
  type ExperimentDefinition,
  type Variant,
} from "./experiments.js";
import {
  BoundedKeySet,
  ExperimentEventQueue,
  EXPOSURE_DEDUP_ENTRIES,
  newEventId,
  type EventSink,
  type ExperimentEvent,
} from "./events.js";

/**
 * A flag value as delivered to the SDK. Boolean flags resolve to booleans,
 * number flags to numbers, and string / list-of-values flags to their stored
 * string verbatim.
 */
export type FlagValue = boolean | number | string | null;

export type ConnectionType = "polling" | "sse" | "webhook";

/** Whether the client is currently receiving updates. */
export type ConnectionState = "connecting" | "live" | "degraded" | "closed";

/** Invoked when the client's ConnectionState transitions. */
export type StateChangeListener = (state: ConnectionState) => void;

/**
 * Observes background errors (transport failures, invalid payloads, recovered
 * read faults). Informational only: it never affects what a read returns, which
 * always falls back to last-known-good.
 */
export type ErrorListener = (error: unknown) => void;

/** Mirror flag values into an external store as they change. */
export interface StorageAdapter {
  createOrUpdate(flagset: string, flagKey: string, value: FlagValue): void;
}

/** A single flag value change, delivered to onChange listeners. */
export interface FlagChange {
  flagset: string;
  flagKey: string;
  value: FlagValue;
  previousValue: FlagValue | undefined;
}

export type FlagChangeListener = (change: FlagChange) => void;

/** A config document: `{ configs: { <entry>: { value, apply_strategy } } }`. */
export type ConfigDocument = Record<string, unknown>;

/** Options for trackConversion / trackMetric. */
export interface TrackOptions {
  /** Subject this conversion belongs to; falls back to defaultTargetingKey. */
  targetingKey?: string;
  /**
   * Attribute the conversion to one experiment. Without it the conversion is
   * reported against every running experiment declaring the metric.
   */
  experimentKey?: string;
}

/**
 * A change to a watched config document delivered to `on(name, ...)` listeners.
 * `name` is the watched config (document) name. `oldValue` / `newValue` are the
 * full documents before and after the change; `oldValue` is null for a newly
 * seen config. `applyStrategy` is "requires_restart" when any changed inner
 * entry requires a restart, else "immediate".
 */
export interface ConfigChangeEvent {
  name: string;
  oldValue: ConfigDocument | null;
  newValue: ConfigDocument;
  applyStrategy: "immediate" | "requires_restart";
}

export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

export interface GooseClientOptions {
  /**
   * The SDK client id (gsc_…). A public, non-secret identifier; the only
   * credential needed for flag reads. See the README.
   */
  clientId: string;
  /**
   * The SDK client secret. Required only for the secret-bearing, **server-side**
   * features — app configs and webhook registration. Leave it unset for a
   * flag-only client. ⚠️ NEVER set this in browser code: a browser cannot keep a
   * secret, so configs/webhooks must run in a server runtime (Node/Deno/Bun).
   */
  clientSecret?: string;
  /** Base URL of the Goose config service, e.g. "https://goose.example.com". */
  serverUrl: string;
  /**
   * Stable caller thumbprint sent on every request for analytics. When unset,
   * the SDK derives a best-effort runtime-specific value.
   */
  thumbprint?: string;
  /** One flagset name or a list of them. */
  flagsets: string | string[];
  /** "polling" (default), "sse", or both. */
  connectionType?: ConnectionType | ConnectionType[];
  /** Default namespace applied to every flagset unless overridden per-flagset. */
  namespaceName?: string;
  /** Per-flagset namespace overrides. */
  flagsetNamespaces?: Record<string, string>;
  /** Stable per-user key used to bucket canary rollouts when getFlag omits one. */
  defaultTargetingKey?: string;
  /** Mirror flag values into an external store as they change. */
  storageAdapter?: StorageAdapter;
  /**
   * Persist last-known-good state and read it back on connect (before any
   * network call), so a restart during an outage warm-starts with real values.
   * Use FileCache for a built-in Node file-backed implementation.
   */
  cache?: PersistentCache;
  /**
   * Restore fail-fast startup: when true, connect() rejects if the first fetch
   * fails. The default (false) is graceful — the client starts degraded, serves
   * cached values or defaults, and heals in the background.
   */
  requireInitialConnect?: boolean;
  /** Observe background errors without affecting reads (see ErrorListener). */
  onError?: ErrorListener;
  /** Polling cadence in seconds (default 5, floored at 1). */
  pollIntervalSeconds?: number;
  /** Per-request timeout in seconds for non-streaming calls (default 10). */
  requestTimeoutSeconds?: number;
  /** Idle-read deadline for the SSE stream in seconds (default 65, floored at 5). */
  sseReadTimeoutSeconds?: number;
  /** If false, the caller must invoke connect() explicitly (default true). */
  autoConnect?: boolean;

  // --- Server-side only (configs + webhooks). Require clientSecret; never use
  // these in a browser. ---

  /**
   * Config document names to watch within `namespaceName`. Delivered on the
   * polling loop. Requires `clientSecret` and `namespaceName`. Server-side only.
   */
  configs?: string[];
  /**
   * Opt into A/B experiments: the client fetches every running experiment in
   * `namespaceName` and `getVariant` assigns locally. Requires `namespaceName`.
   *
   * Unlike `configs`, this works in the browser: experiments authenticate with
   * the publishable `clientId` alone. The flip side is that variant payloads
   * are readable by anyone who can read your client id — never put a secret in
   * one.
   */
  enableExperiments?: boolean;
  /**
   * This application's own version ("2.4.0", "v2.4.1-rc.1"). Optional. When set,
   * config entries carrying `min_app_version` / `max_app_version` are gated
   * against it: an entry whose range excludes this version resolves to its
   * `default` instead of its `value`, and changes to it never trigger a
   * requires_restart. When unset no gating happens and every entry applies.
   */
  appVersion?: string;
  /**
   * Raise SIGINT (after drains run) when a requires_restart config changes, so an
   * orchestrator restarts the process. Node-only; ignored where `process` is
   * unavailable.
   */
  restartOnRequiredChange?: boolean;
  /** Webhook target URL the server posts deltas to. Required for webhook mode. */
  webhookTargetUrl?: string;
  /** Shared webhook secret (auto-generated if omitted). */
  webhookSecret?: string;
  /** Prefix for registered webhook names (default "goose-js-sdk"). */
  webhookNamePrefix?: string;
  /** Start the embedded Node HTTP listener for webhook mode (default true). */
  webhookListenerEnabled?: boolean;
  /** Embedded listener bind host (default "0.0.0.0"). */
  webhookListenerHost?: string;
  /** Embedded listener port (default 8091). */
  webhookListenerPort?: number;
  /** Embedded listener path (default derived from webhookTargetUrl, else "/webhook"). */
  webhookListenerPath?: string;
}

export class GooseSDKError extends Error {}

export class GooseSDKHTTPError extends GooseSDKError {
  readonly statusCode: number;
  readonly responseText: string;
  /** Server Retry-After hint in seconds (e.g. on a 429), or 0 when absent. */
  readonly retryAfter: number;

  constructor(statusCode: number, message: string, responseText = "", retryAfter = 0) {
    super(message);
    this.name = "GooseSDKHTTPError";
    this.statusCode = statusCode;
    this.responseText = responseText;
    this.retryAfter = retryAfter;
  }
}

// How long an SSE stream must stay connected to be judged healthy (resets
// reconnect backoff + clears the SSE-down marker), and the consecutive
// reconnect-failure count (SSE-only) after which fallback polling starts.
const SSE_STABLE_INTERVAL_MS = 30_000;
const SSE_FALLBACK_THRESHOLD = 3;

/**
 * Exponential backoff with equal jitter (in milliseconds) for retry loops. Half
 * the exponential window is fixed and half is random, so delays never collapse
 * toward zero (which would hammer a recovering server) yet still spread a fleet
 * of clients out. Capped, and reset to base on a healthy interval.
 */
class Backoff {
  private attempt = 0;

  constructor(private readonly baseMs: number, private readonly capMs: number) {}

  reset(): void {
    this.attempt = 0;
  }

  durationMs(): number {
    let window = this.baseMs * 2 ** this.attempt;
    if (window >= this.capMs) {
      window = this.capMs;
    } else {
      this.attempt += 1;
    }
    const half = window / 2;
    const jitter = Math.random() * half;
    return Math.min(Math.max(half + jitter, this.baseMs), this.capMs);
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to seconds; 0 if absent/past. */
function parseRetryAfter(value: string | null): number {
  if (!value) {
    return 0;
  }
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isInteger(seconds)) {
    return seconds > 0 ? seconds : 0;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = (date - Date.now()) / 1000;
    return delta > 0 ? delta : 0;
  }
  return 0;
}

/**
 * Coerce a raw value to its declared type and report whether the result is
 * usable. A null/undefined value, or one that fails to match its declared type
 * (e.g. a non-numeric string for a number flag), is rejected so callers retain
 * the last-known-good value instead of caching garbage.
 */
function coerceAndValidate(raw: unknown, dataType: string): [FlagValue, boolean] {
  if (raw === null || raw === undefined) {
    return [null, false];
  }
  const value = coerceValue(raw, dataType);
  const normalized = dataType.trim().toLowerCase();
  if (normalized === "bool") {
    return [value, typeof value === "boolean"];
  }
  if (["number", "int", "integer", "float", "double"].includes(normalized)) {
    return [value, typeof value === "number" && Number.isFinite(value)];
  }
  return [value, true];
}

interface RolloutConfig {
  percentage: number | null;
  salt: string | null;
  value: FlagValue | undefined;
}

interface RawFlag {
  [key: string]: unknown;
}

/**
 * Deterministically map a user to a bucket in [0, 99] by hashing
 * `salt:flagKey:targetingKey` with SHA-256 (via Web Crypto) and reducing the
 * first 8 digest bytes mod 100. The salt is stable per flag, so ramps are
 * sticky: growing the percentage never reshuffles existing buckets. The 64-bit
 * reduction uses modular arithmetic — (a * 256 + b) % 100 — to stay exact
 * without BigInt.
 */
async function bucketUser(salt: string, flagKey: string, targetingKey: string): Promise<number> {
  const data = new TextEncoder().encode(`${salt}:${flagKey}:${targetingKey}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let bucket = 0;
  for (let i = 0; i < 8; i++) {
    bucket = (bucket * 256 + digest[i]) % 100;
  }
  return bucket;
}

/**
 * Pull canary rollout config from a flag / delta payload. Accepts both
 * snake_case (config/poll responses) and camelCase (SSE deltas). A missing
 * percentage means the flag has no rollout configured.
 */
function extractRollout(raw: RawFlag): RolloutConfig {
  const rawPercentage = raw["rollout_percentage"] ?? raw["rolloutPercentage"];
  const salt = raw["rollout_salt"] ?? raw["rolloutSalt"];
  const value = raw["rollout_value"] ?? raw["rolloutValue"];

  let percentage: number | null = null;
  if (rawPercentage !== undefined && rawPercentage !== null) {
    const parsed = Number(rawPercentage);
    percentage = Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  return {
    percentage,
    salt: typeof salt === "string" ? salt : null,
    value: (value as FlagValue) ?? undefined,
  };
}

/** Coerce a raw stored value to the type implied by the flag's data type. */
function coerceValue(value: unknown, dataType: string): FlagValue {
  const normalized = dataType.trim().toLowerCase();

  if (normalized === "bool") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value.trim().toLowerCase() === "true";
    }
  }

  if (["number", "int", "integer", "float", "double"].includes(normalized)) {
    if (typeof value === "number") {
      return value;
    }
    const text = String(value ?? "").trim();
    if (text === "") {
      return value as FlagValue;
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : (value as FlagValue);
  }

  return value as FlagValue;
}

/**
 * Parse a server timestamp to unix seconds. Handles ISO-8601 and Go's
 * time.String() form ("2006-01-02 15:04:05.999999 +0000 UTC"). Returns null
 * when unparseable.
 */
function toUnixSeconds(raw: string): number | null {
  const value = raw.trim();
  if (value === "") {
    return null;
  }

  const isoParsed = Date.parse(value);
  if (Number.isFinite(isoParsed)) {
    return Math.floor(isoParsed / 1000);
  }

  // Go's time.String() style — treat the wall-clock portion as UTC.
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    return Math.floor(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000,
    );
  }

  return null;
}

const MAX_SEEN_EVENT_IDS = 2048;
const sdkClientThumbprintHeader = "X-Goose-Client-Thumbprint";
const fallbackRuntimeThumbprints = new Map<string, string>();

export interface GetFlagOptions {
  /**
   * Attributes used for segment targeting. Separate from targetingKey: the key
   * decides which side of a canary a subject lands on, the context decides
   * whether they are in the audience at all.
   */
  context?: EvaluationContext;
  flagset?: string;
  default?: FlagValue;
  targetingKey?: string;
}

/**
 * SDK for the Goose config service. Reads feature flags by polling and/or a live
 * SSE stream, evaluating canary rollouts client-side, and emits change events.
 *
 * Used with only a client id it is browser-safe and reads flags. Given a client
 * secret it additionally supports the **server-side** features — app configs and
 * webhooks — which must run in a server runtime (Node/Deno/Bun), never a browser.
 * See the README.
 */
export class GooseSDK {
  readonly clientId: string;
  readonly serverUrl: string;
  readonly flagsets: string[];
  readonly connectionTypes: Set<ConnectionType>;
  readonly namespaceName: string | null;

  private readonly clientSecret: string;
  private readonly thumbprintPromise: Promise<string>;
  private readonly flagsetNamespaces: Record<string, string>;
  private readonly defaultTargetingKey: string | null;
  private readonly storageAdapter: StorageAdapter | null;
  private readonly cache: PersistentCache | null;
  private readonly requireInitialConnect: boolean;
  private readonly pollIntervalSeconds: number;
  private readonly requestTimeoutSeconds: number;
  private readonly sseReadTimeoutSeconds: number;

  private readonly configNames: string[];
  private readonly restartOnRequiredChange: boolean;
  private readonly webhookTargetUrl: string | null;
  private readonly webhookSecret: string;
  private readonly webhookNamePrefix: string;
  private readonly webhookListenerEnabled: boolean;
  private readonly webhookListenerHost: string;
  private readonly webhookListenerPort: number;
  private readonly webhookListenerPath: string;

  private readonly flags: Map<string, Map<string, FlagValue>> = new Map();
  private readonly flagDataTypes: Map<string, Map<string, string>> = new Map();
  private readonly rollouts: Map<string, Map<string, RolloutConfig>> = new Map();
  /**
   * Per-flagset, per-flag segment overrides, kept beside rollouts because both
   * are evaluated locally on the read path.
   */
  private readonly segments: Map<string, Map<string, SegmentTargeting>> = new Map();
  private readonly pollCursors: Map<string, number> = new Map();
  private readonly changeListeners: Set<FlagChangeListener> = new Set();
  private readonly seenEventIds: Set<string> = new Set();

  private readonly configs: Map<string, { document: ConfigDocument; revision: number }> = new Map();
  /**
   * Experiments are namespace-wide rather than watched by name, so the whole
   * set is replaced on each fetch. `experimentsLoaded` distinguishes "not
   * fetched yet" from "the server does not serve this experiment".
   */
  private readonly experimentsEnabled: boolean;
  private experiments: Map<string, ExperimentDefinition> = new Map();
  private experimentsLoaded = false;
  private readonly exposureSeen = new BoundedKeySet(EXPOSURE_DEDUP_ENTRIES);
  private readonly experimentEvents: ExperimentEventQueue;
  /** Options.appVersion as supplied, for log messages. */
  private readonly appVersionRaw: string;
  /** Parsed appVersion; null when unset or unparseable, which disables gating. */
  private readonly appVersion: number[] | null;
  /** "<config name>\u0000<entry key>" of entries already warned about as deprecated. */
  private readonly warnedDeprecated: Set<string> = new Set();
  private readonly configListeners: Map<string, Set<ConfigChangeListener>> = new Map();
  private readonly restartListeners: Set<ConfigChangeListener> = new Set();
  private webhookEventsReceivedCount = 0;
  // The embedded Node http.Server instance (any-typed: loaded via dynamic import
  // so the browser build pulls in no Node types or modules).
  private webhookServer: { close: (cb?: () => void) => void } | null = null;

  private connected = false;
  private initialized = false;
  private stopped = false;
  private readonly abortControllers: Set<AbortController> = new Set();
  private readonly loopPromises: Promise<void>[] = [];

  // Self-healing state.
  private connectionState: ConnectionState = "connecting";
  private lastSyncAt: number | null = null;
  private consecutiveFailures = 0;
  private readonly stateListeners: Set<StateChangeListener> = new Set();
  private readonly errorListeners: Set<ErrorListener> = new Set();
  // SSE→polling fallback: flagsets whose SSE stream is down, plus the temporary
  // polling loop that keeps them fresh meanwhile.
  private readonly sseDownFlagsets: Set<string> = new Set();
  private fallbackStopped = true;
  private fallbackLoopActive = false;
  // Debounced cache flusher.
  private cacheDirty = false;
  private cacheFlushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: GooseClientOptions) {
    const clientId = (options.clientId ?? "").trim();
    const serverUrl = (options.serverUrl ?? "").trim();
    if (!clientId || !serverUrl) {
      throw new GooseSDKError("clientId and serverUrl are required");
    }

    this.clientId = clientId;
    // The client secret is only sent on secret-bearing endpoints (app configs +
    // webhook registration). Flag reads authenticate by client_id alone, so a
    // flag-only client may omit it. The requirement is enforced below.
    this.clientSecret = (options.clientSecret ?? "").trim();
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.thumbprintPromise = resolveThumbprint(options.thumbprint, clientId);
    this.flagsets = normalizeFlagsets(options.flagsets);
    if (this.flagsets.length === 0) {
      throw new GooseSDKError("at least one flagset is required");
    }

    this.connectionTypes = normalizeConnectionTypes(options.connectionType);
    this.namespaceName = normalizeNamespace(options.namespaceName);
    this.flagsetNamespaces = this.buildFlagsetNamespaces(options.flagsetNamespaces);
    this.defaultTargetingKey = normalizeNamespace(options.defaultTargetingKey);
    this.storageAdapter = options.storageAdapter ?? null;
    this.cache = options.cache ?? null;
    this.requireInitialConnect = options.requireInitialConnect === true;
    if (options.onError) {
      this.errorListeners.add(options.onError);
    }
    this.pollIntervalSeconds = Math.max(1, options.pollIntervalSeconds ?? 5);
    this.requestTimeoutSeconds = Math.max(1, options.requestTimeoutSeconds ?? 10);
    this.sseReadTimeoutSeconds = Math.max(5, options.sseReadTimeoutSeconds ?? 65);

    // Watched config names resolve against the client-level namespaceName.
    this.experimentsEnabled = options.enableExperiments === true;
    this.experimentEvents = new ExperimentEventQueue(this.buildEventSink());
    this.configNames = normalizeFlagsets(options.configs ?? []);
    this.restartOnRequiredChange = options.restartOnRequiredChange === true;
    // An unparseable appVersion fails open: gating is skipped entirely rather
    // than silently resolving every gated entry to its default.
    this.appVersionRaw = (options.appVersion ?? "").trim();
    this.appVersion = this.appVersionRaw === "" ? null : parseAppVersion(this.appVersionRaw);
    if (this.appVersionRaw !== "" && this.appVersion === null) {
      console.warn(
        `goose-sdk: ignoring unparseable appVersion '${this.appVersionRaw}'; config app-version gating is disabled`,
      );
    }
    if (this.configNames.length > 0 && this.namespaceName === null) {
      throw new GooseSDKError("namespaceName is required when watching configs");
    }
    if (this.experimentsEnabled && this.namespaceName === null) {
      throw new GooseSDKError("namespaceName is required when experiments are enabled");
    }

    const wantsWebhook = this.connectionTypes.has("webhook");
    this.webhookTargetUrl = normalizeNamespace(options.webhookTargetUrl);
    if (wantsWebhook) {
      if (!this.webhookTargetUrl) {
        throw new GooseSDKError("webhookTargetUrl is required when connectionType includes webhook");
      }
      if (!isAbsoluteUrl(this.webhookTargetUrl)) {
        throw new GooseSDKError("webhookTargetUrl must be an absolute URL");
      }
    }

    // App configs and webhook registration are secret-bearing endpoints. A
    // browser cannot keep a secret, so these are server-side only.
    if ((this.configNames.length > 0 || wantsWebhook) && !this.clientSecret) {
      throw new GooseSDKError("clientSecret is required when watching configs or using webhooks");
    }

    this.webhookSecret = (options.webhookSecret ?? "").trim() || generateWebhookSecret();
    this.webhookNamePrefix = (options.webhookNamePrefix ?? "").trim() || "goose-js-sdk";
    this.webhookListenerEnabled = options.webhookListenerEnabled !== false;
    this.webhookListenerHost = (options.webhookListenerHost ?? "").trim() || "0.0.0.0";
    this.webhookListenerPort = options.webhookListenerPort ?? 8091;
    this.webhookListenerPath = resolveWebhookPath(options.webhookListenerPath, this.webhookTargetUrl);

    for (const flagset of this.flagsets) {
      this.flags.set(flagset, new Map());
      this.flagDataTypes.set(flagset, new Map());
      this.rollouts.set(flagset, new Map());
      this.pollCursors.set(flagset, 0);
    }

    if (options.autoConnect !== false) {
      // Fire-and-forget by default; callers that want to await readiness should
      // pass autoConnect: false and await connect(). Graceful connect resolves
      // even when the server is down, so a rejection here only surfaces an
      // unexpected fault (or requireInitialConnect) — route it to onError.
      void this.connect().catch((error) => {
        console.error("goose-sdk: auto-connect failed:", error);
        this.emitError(error);
      });
    }
  }

  /**
   * Fetch the initial snapshot and start the configured connection loops.
   *
   * Graceful by default: if the initial fetch fails it does not reject but
   * starts in the "degraded" state, serving warm-started cache values (or
   * defaults) while the background loops heal. Set requireInitialConnect to
   * restore fail-fast behavior.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.stopped = false;

    if (this.experimentsEnabled) {
      // Batches exposures and conversions so getVariant in a render path costs
      // a hash rather than a request, and flushes on page hide.
      this.experimentEvents.start();
    }

    // Warm start: hydrate last-known-good from the cache before any network call.
    await this.loadFromCache();

    try {
      await this.refresh();
      this.recordSuccess();
    } catch (error) {
      if (this.requireInitialConnect) {
        throw error;
      }
      console.warn("goose-sdk: initial refresh failed; starting in degraded mode and healing in background:", error);
      this.recordFailure(error);
    }

    if (this.connectionTypes.has("webhook")) {
      if (this.webhookListenerEnabled) {
        try {
          await this.startWebhookListener();
        } catch (error) {
          if (this.requireInitialConnect) {
            throw error;
          }
          console.warn("goose-sdk: webhook listener failed to start:", error);
          this.emitError(error);
        }
      }
      try {
        await this.registerWebhooks();
      } catch (error) {
        if (this.requireInitialConnect) {
          throw error;
        }
        console.warn("goose-sdk: webhook registration failed:", error);
        this.emitError(error);
      }
    }

    if (this.connectionTypes.has("polling")) {
      this.loopPromises.push(this.pollingLoop());
    }
    if (this.connectionTypes.has("sse")) {
      for (const flagset of this.flagsets) {
        this.loopPromises.push(this.sseLoop(flagset));
      }
    }

    this.connected = true;
  }

  /** Stop all loops, abort in-flight requests, and shut down the webhook listener. */
  close(): void {
    this.stopped = true;
    this.fallbackStopped = true;
    // Flush buffered events before the abort below cancels in-flight requests;
    // close() is sync by contract, so this is best-effort.
    void this.experimentEvents.close();
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    this.stopWebhookListener();
    if (this.cacheFlushTimer) {
      clearTimeout(this.cacheFlushTimer);
      this.cacheFlushTimer = undefined;
    }
    this.setState("closed");
    if (this.cache && this.cacheDirty) {
      this.cacheDirty = false;
      void this.flushCache(); // best-effort final flush
    }
    this.connected = false;
  }

  /** Refresh every flagset's snapshot (or poll once if already initialized). */
  async refresh(): Promise<void> {
    if (this.initialized && this.connectionTypes.has("polling")) {
      for (const flagset of this.flagsets) {
        await this.pollOnce(flagset);
      }
      if (this.configNames.length > 0) {
        await this.pollConfigsOnce();
        await this.pollExperimentsOnce();
      }
      return;
    }

    for (const flagset of this.flagsets) {
      const snapshot = await this.fetchConfigSnapshot(flagset);
      const flags = Array.isArray(snapshot["flags"]) ? (snapshot["flags"] as RawFlag[]) : [];
      this.applySnapshot(flagset, flags);
      const cursor = this.maxUpdatedTimestamp(flags) ?? Math.floor(Date.now() / 1000);
      this.pollCursors.set(flagset, Math.max(this.pollCursors.get(flagset) ?? 0, cursor));
    }

    if (this.configNames.length > 0) {
      await this.fetchConfigsSnapshot();
      await this.fetchExperimentsSnapshot();
    }

    this.initialized = true;
  }

  /**
   * Return a flag's value. When the flag has a canary rollout configured, the
   * value is evaluated client-side by deterministically bucketing targetingKey
   * (falling back to defaultTargetingKey): in-bucket users get the candidate
   * value, everyone else the baseline. Flags without a rollout return their
   * stored value unchanged.
   *
   * Async because canary evaluation hashes via Web Crypto (crypto.subtle).
   */
  async getFlag(flagKey: string, options: GetFlagOptions = {}): Promise<FlagValue> {
    const flagset = this.resolveFlagset(options.flagset);

    const flagValues = this.flags.get(flagset);
    // Fallback ladder: last-known-good stored value → caller default.
    const fallback = flagValues?.has(flagKey)
      ? (flagValues.get(flagKey) as FlagValue)
      : (options.default ?? null);
    const rollout = this.rollouts.get(flagset)?.get(flagKey);
    const dataType = this.flagDataTypes.get(flagset)?.get(flagKey) ?? "";
    const targeting = this.segments.get(flagset)?.get(flagKey);

    // A read must never reject or return garbage. If rollout evaluation throws
    // on unexpected data, fall back to last-known-good.
    try {
      // Segment targeting resolves before the canary: being in the audience is
      // a statement about who you are, while a canary is about what fraction
      // of traffic sees something. A subject in the segment gets the targeted
      // value outright rather than being re-diced.
      if (targeting && matchesSegment(targeting.definition, options.context ?? {})) {
        return coerceValue(targeting.value, dataType);
      }

      if (rollout && rollout.percentage !== null) {
        return await this.evaluateRollout(flagKey, rollout, options.targetingKey, fallback, dataType);
      }
      return fallback;
    } catch (error) {
      console.warn(`goose-sdk: flag resolution recovered for ${flagKey}; returning last-known-good:`, error);
      this.emitError(error);
      return fallback;
    }
  }

  /** Return a { flagset: { flagKey: value } } copy of all known flags. */
  snapshot(): Record<string, Record<string, FlagValue>> {
    const result: Record<string, Record<string, FlagValue>> = {};
    for (const [flagset, values] of this.flags) {
      result[flagset] = Object.fromEntries(values);
    }
    return result;
  }

  /** Subscribe to flag value changes. Returns an unsubscribe function. */
  onChange(listener: FlagChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  // --- Health / self-healing ---

  /** The client's current connection state. */
  state(): ConnectionState {
    return this.connectionState;
  }

  /** Epoch milliseconds of the last successful sync, or null if none yet. */
  lastSync(): number | null {
    return this.lastSyncAt;
  }

  /**
   * Whether served values may be stale — no successful sync within
   * max(3×pollInterval, sseReadTimeout). A never-synced client is stale.
   */
  isStale(): boolean {
    if (this.lastSyncAt === null) {
      return true;
    }
    const windowMs = Math.max(3 * this.pollIntervalSeconds, this.sseReadTimeoutSeconds) * 1000;
    return Date.now() - this.lastSyncAt > windowMs;
  }

  /** Subscribe to connection-state transitions. Returns an unsubscribe function. */
  onStateChange(listener: StateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Subscribe to background errors (never affect reads). Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private recordSuccess(): void {
    this.lastSyncAt = Date.now();
    this.consecutiveFailures = 0;
    this.setState("live");
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.setState("degraded");
    this.emitError(error);
  }

  private setState(next: ConnectionState): void {
    if (this.connectionState === "closed" || this.connectionState === next) {
      return;
    }
    this.connectionState = next;
    for (const listener of this.stateListeners) {
      try {
        listener(next);
      } catch (error) {
        console.warn("goose-sdk: onStateChange listener failed:", error);
      }
    }
  }

  private emitError(error: unknown): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch (nested) {
        console.warn("goose-sdk: onError listener failed:", nested);
      }
    }
  }

  private async honorRetryAfter(error: unknown): Promise<void> {
    if (error instanceof GooseSDKHTTPError && error.statusCode === 429 && error.retryAfter > 0) {
      await this.sleep(error.retryAfter * 1000);
    }
  }

  // --- Persistent cache (warm start + debounced save) ---

  private async loadFromCache(): Promise<void> {
    if (!this.cache) {
      return;
    }
    let snapshot: Snapshot | null;
    try {
      snapshot = await this.cache.load();
    } catch (error) {
      console.warn("goose-sdk: cache load failed:", error);
      this.emitError(error);
      return;
    }
    if (!snapshot) {
      return;
    }

    for (const flagset of this.flagsets) {
      const flags = snapshot.flags?.[flagset];
      if (flags) {
        for (const [key, value] of Object.entries(flags)) {
          this.flags.get(flagset)?.set(key, value);
        }
      }
      const types = snapshot.flagDataTypes?.[flagset];
      if (types) {
        for (const [key, value] of Object.entries(types)) {
          this.flagDataTypes.get(flagset)?.set(key, value);
        }
      }
      const rollouts = snapshot.rollouts?.[flagset];
      if (rollouts) {
        for (const [key, r] of Object.entries(rollouts)) {
          this.rollouts.get(flagset)?.set(key, { percentage: r.percentage, salt: r.salt, value: r.value });
        }
      }
      const cursor = snapshot.pollCursors?.[flagset];
      if (typeof cursor === "number" && cursor > (this.pollCursors.get(flagset) ?? 0)) {
        this.pollCursors.set(flagset, cursor);
      }
    }
    for (const name of this.configNames) {
      const entry = snapshot.configs?.[name];
      if (entry && entry.document) {
        this.configs.set(name, { document: entry.document, revision: entry.revision ?? 0 });
      }
    }
    console.info("goose-sdk: warm-started from persistent cache");
  }

  private markDirty(): void {
    if (!this.cache || this.stopped) {
      return;
    }
    this.cacheDirty = true;
    if (!this.cacheFlushTimer) {
      // Debounce: coalesce a burst of deltas into a single write ~1s later.
      this.cacheFlushTimer = setTimeout(() => {
        this.cacheFlushTimer = undefined;
        if (this.cacheDirty) {
          this.cacheDirty = false;
          void this.flushCache();
        }
      }, 1000);
    }
  }

  private async flushCache(): Promise<void> {
    if (!this.cache) {
      return;
    }
    try {
      await this.cache.save(this.buildSnapshot());
    } catch (error) {
      console.warn("goose-sdk: cache save failed:", error);
      this.emitError(error);
    }
  }

  private buildSnapshot(): Snapshot {
    const flags: Record<string, Record<string, FlagValue>> = {};
    for (const [flagset, values] of this.flags) {
      flags[flagset] = Object.fromEntries(values);
    }
    const flagDataTypes: Record<string, Record<string, string>> = {};
    for (const [flagset, values] of this.flagDataTypes) {
      flagDataTypes[flagset] = Object.fromEntries(values);
    }
    const rollouts: Record<string, Record<string, RolloutConfig>> = {};
    for (const [flagset, values] of this.rollouts) {
      rollouts[flagset] = Object.fromEntries(
        [...values].map(([key, r]) => [key, { percentage: r.percentage, salt: r.salt, value: r.value }]),
      );
    }
    const pollCursors: Record<string, number> = Object.fromEntries(this.pollCursors);
    const configs: Record<string, ConfigSnapshot> = {};
    for (const [name, entry] of this.configs) {
      configs[name] = {
        document: redactSensitiveConfigEntries(entry.document),
        revision: entry.revision,
      };
    }
    return { flags, flagDataTypes, rollouts, pollCursors, configs };
  }

  // --- SSE→polling fallback ---

  private markSseDown(flagset: string): void {
    if (this.connectionTypes.has("polling")) {
      return; // steady polling already keeps flags fresh
    }
    this.sseDownFlagsets.add(flagset);
    if (!this.fallbackLoopActive) {
      this.fallbackLoopActive = true;
      this.fallbackStopped = false;
      this.loopPromises.push(this.fallbackPollingLoop());
      console.warn(`goose-sdk: sse unavailable; starting fallback polling (flagset ${flagset})`);
    }
  }

  private markSseUp(flagset: string): void {
    this.sseDownFlagsets.delete(flagset);
    if (this.sseDownFlagsets.size === 0 && this.fallbackLoopActive) {
      this.fallbackStopped = true;
      this.fallbackLoopActive = false;
    }
  }

  private async fallbackPollingLoop(): Promise<void> {
    while (!this.stopped && !this.fallbackStopped) {
      for (const flagset of this.flagsets) {
        try {
          await this.pollOnce(flagset);
          this.recordSuccess();
        } catch (error) {
          if (!this.stopped) {
            this.recordFailure(error);
          }
        }
      }
      if (this.configNames.length > 0) {
        try {
          await this.pollConfigsOnce();
        await this.pollExperimentsOnce();
        } catch (error) {
          if (!this.stopped) {
            this.recordFailure(error);
          }
        }
      }
      await this.sleep(this.pollIntervalSeconds * 1000);
    }
  }

  /**
   * Validate an incoming value and, only if usable, store its data type,
   * rollout, and value. A malformed value is rejected (logged + reported to
   * onError) so the last-known-good value is retained.
   */
  private commitFlag(
    flagset: string,
    flagKey: string,
    dataType: string,
    raw: unknown,
    rollout: RolloutConfig,
    targeting: SegmentTargeting | null = null,
  ): void {
    const [value, ok] = coerceAndValidate(raw, dataType);
    if (!ok) {
      console.warn(
        `goose-sdk: rejecting malformed flag value; retaining last-known-good (flagset ${flagset}, flag ${flagKey}, type ${dataType})`,
      );
      this.emitError(
        new GooseSDKError(`malformed value for flag '${flagKey}' in flagset '${flagset}' (data type '${dataType}')`),
      );
      return;
    }
    this.flagDataTypes.get(flagset)?.set(flagKey, dataType);
    this.rollouts.get(flagset)?.set(flagKey, rollout);
    let flagsetSegments = this.segments.get(flagset);
    if (!flagsetSegments) {
      flagsetSegments = new Map();
      this.segments.set(flagset, flagsetSegments);
    }
    if (targeting) {
      flagsetSegments.set(flagKey, targeting);
    } else {
      // A payload with no segment means targeting was removed; clearing it
      // mirrors how a delta with no percentage clears a canary.
      flagsetSegments.delete(flagKey);
    }
    this.setFlag(flagset, flagKey, value);
  }

  // --- Configs (server-side) ---

  /**
   * Return a watched config's current document, or `fallback` if unset. A config
   * is a named JSON document shaped `{ configs: { <entry>: { value,
   * apply_strategy } } }`; the whole document is returned. Reading an unwatched
   * name logs a warning and returns `fallback`.
   */
  getConfig(name: string, fallback: ConfigDocument | null = null): ConfigDocument | null {
    if (!this.configNames.includes(name)) {
      console.warn(`goose-sdk: getConfig('${name}') called for an unwatched config name`);
      return fallback;
    }
    const entry = this.configs.get(name);
    return entry ? entry.document : fallback;
  }

  /**
   * Return a single entry's value from within a watched config document (e.g.
   * getConfigValue("frontend", "dashboard_layout")). Returns `fallback` when the
   * config is not watched, not yet loaded, the key is absent, or malformed.
   *
   * This is where per-entry metadata is applied. When the client was built with
   * an `appVersion` and the entry's min/max_app_version range excludes it, the
   * entry's `default` is returned instead of its `value` (and `fallback` when it
   * has no default). A `deprecated` entry warns the first time it is read.
   * Reading an entry straight out of getConfig's document bypasses all of this.
   */
  getConfigValue(name: string, key: string, fallback: unknown = undefined): unknown {
    const document = this.getConfig(name, null);
    if (!document || typeof document !== "object") {
      return fallback;
    }
    const entries = (document as Record<string, unknown>)["configs"];
    if (!entries || typeof entries !== "object") {
      return fallback;
    }
    const entry = (entries as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") {
      return fallback;
    }
    this.warnDeprecatedOnce(name, key, entry as Record<string, unknown>);
    const resolved = resolveConfigEntry(entry as Record<string, unknown>, this.appVersion);
    return resolved.found ? resolved.value : fallback;
  }

  /**
   * Warn on the first read of an entry marked deprecated, naming its
   * `replaced_by` successor when set. Later reads stay quiet so a hot path does
   * not flood the console.
   */
  private warnDeprecatedOnce(name: string, key: string, entry: Record<string, unknown>): void {
    if (entry["deprecated"] !== true) {
      return;
    }
    const cacheKey = `${name}\u0000${key}`;
    if (this.warnedDeprecated.has(cacheKey)) {
      return;
    }
    this.warnedDeprecated.add(cacheKey);
    const replacedBy = String(entry["replaced_by"] ?? "").trim();
    console.warn(
      replacedBy === ""
        ? `goose-sdk: config entry '${name}.${key}' is deprecated`
        : `goose-sdk: config entry '${name}.${key}' is deprecated; use '${replacedBy}' instead`,
    );
  }

  // --- Experiments (browser-safe) ---

  /**
   * Return the subject's arm in an experiment.
   *
   * Async because bucketing hashes via Web Crypto, matching `getFlag`. The
   * targeting key follows the same precedence as flag rollouts: the per-call
   * value, then `defaultTargetingKey`, then give up.
   *
   * Calling this records an exposure (once per subject per experiment), which
   * is what puts the subject in the denominator. A paused experiment still
   * returns its arm but records nothing.
   */
  async getVariant(experimentKey: string, targetingKey?: string): Promise<Variant> {
    const subject = (targetingKey ?? this.defaultTargetingKey ?? "").trim();
    if (!subject) {
      console.warn(
        `goose-sdk: getVariant('${experimentKey}') called with no targeting key; returning no assignment`,
      );
      return { key: null, payload: undefined, inExperiment: false, reason: "no_targeting_key" };
    }

    const definition = this.experiments.get(experimentKey);
    if (!definition) {
      // "Not fetched yet" and "no such experiment" are different problems: one
      // is transient, the other is a typo in the caller's code.
      if (!this.experimentsLoaded) {
        return { key: null, payload: undefined, inExperiment: false, reason: "not_loaded" };
      }
      console.warn(`goose-sdk: getVariant('${experimentKey}') called for an unknown experiment`);
      return { key: null, payload: undefined, inExperiment: false, reason: "unknown_experiment" };
    }

    // A stopped experiment that pinned a winner serves it to everyone, so a
    // concluded test keeps behaving consistently until the code is removed.
    if (definition.winner_variant_key) {
      return {
        key: definition.winner_variant_key,
        payload: variantPayload(definition, definition.winner_variant_key),
        inExperiment: true,
        reason: "assigned",
      };
    }

    const variantKey = await assignVariant(definition, subject);
    if (variantKey === null) {
      return { key: null, payload: undefined, inExperiment: false, reason: "not_eligible" };
    }

    if (definition.status !== EXPERIMENT_STATUS_PAUSED) {
      this.recordExposure(experimentKey, variantKey, subject);
    }

    return {
      key: variantKey,
      payload: variantPayload(definition, variantKey),
      inExperiment: true,
      reason: "assigned",
    };
  }

  /**
   * Record that a subject converted on a metric. Repeat calls count as events,
   * but the subject still converts once, so a rate cannot exceed 100%.
   *
   * Reported against every running experiment that declares the metric, which
   * is usually what you want when one purchase is an outcome for several
   * concurrent tests. Pass `experimentKey` to scope it to one.
   */
  trackConversion(metricKey: string, options: TrackOptions = {}): void {
    this.trackMetricValue(metricKey, 1, options);
  }

  /** Record a numeric outcome, such as order value. Values accumulate per subject. */
  trackMetric(metricKey: string, value: number, options: TrackOptions = {}): void {
    this.trackMetricValue(metricKey, value, options);
  }

  /** Send any buffered events now. Also runs on a timer, on page hide and on close. */
  async flushEvents(): Promise<void> {
    await this.experimentEvents.flush();
  }

  /** How many events were discarded. Non-zero means results are missing data. */
  droppedExperimentEvents(): number {
    return this.experimentEvents.droppedCount;
  }

  /** The experiments currently known to this client; useful when debugging. */
  experimentKeys(): string[] {
    return [...this.experiments.keys()].sort();
  }

  private trackMetricValue(metricKey: string, value: number, options: TrackOptions): void {
    const subject = (options.targetingKey ?? this.defaultTargetingKey ?? "").trim();
    if (!subject) {
      console.warn(`goose-sdk: conversion '${metricKey}' tracked with no targeting key; dropping`);
      return;
    }

    const occurredAt = new Date().toISOString();
    for (const [key, definition] of this.experiments) {
      if (options.experimentKey && key !== options.experimentKey) {
        continue;
      }
      if (definition.status === EXPERIMENT_STATUS_PAUSED) {
        continue;
      }
      if (!definition.metric_keys?.includes(metricKey)) {
        continue;
      }
      this.experimentEvents.enqueue({
        event_id: newEventId(),
        type: "conversion",
        experiment_key: key,
        metric_key: metricKey,
        value,
        targeting_key: subject,
        occurred_at: occurredAt,
      });
    }
  }

  private recordExposure(experimentKey: string, variantKey: string, subject: string): void {
    const dedupKey = `${experimentKey}\u0000${variantKey}\u0000${subject}`;
    if (this.exposureSeen.seen(dedupKey)) {
      return;
    }
    this.experimentEvents.enqueue(
      {
        event_id: newEventId(),
        type: "exposure",
        experiment_key: experimentKey,
        variant_key: variantKey,
        targeting_key: subject,
        occurred_at: new Date().toISOString(),
      },
      // A dropped exposure must forget its dedup key, or this subject is
      // missing from the denominator for the life of the page.
      () => this.exposureSeen.forget(dedupKey),
    );
  }

  private buildEventSink(): EventSink {
    return {
      send: async (events: ExperimentEvent[]) => {
        await this.request("POST", "/api/v1/experiments/events", {
          body: this.experimentEventBody(events),
        });
      },
      sendBeacon: (events: ExperimentEvent[]) => {
        // A closing tab gets no async work; sendBeacon is the only thing that
        // reliably survives unload.
        if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
          return false;
        }
        try {
          const blob = new Blob([JSON.stringify(this.experimentEventBody(events))], {
            type: "application/json",
          });
          return navigator.sendBeacon(`${this.serverUrl}/api/v1/experiments/events`, blob);
        } catch {
          return false;
        }
      },
      onDrop: (event, reason) => {
        // A lost conversion biases the numerator, which is worse than a lost
        // exposure, so it is louder.
        if (event.type === "conversion") {
          console.error(`goose-sdk: experiment conversion dropped (${reason})`, event.metric_key);
        } else {
          console.warn(`goose-sdk: experiment exposure dropped (${reason})`, event.experiment_key);
        }
      },
    };
  }

  private experimentEventBody(events: ExperimentEvent[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      client_id: this.clientId,
      namespace_name: this.namespaceName ?? "",
      events,
    };
    // Sent when the client has one, which an experiment with
    // allow_public_ingest=false requires. A browser client without a secret
    // still reports fine against a public experiment.
    if (this.clientSecret) {
      body.client_secret = this.clientSecret;
    }
    return body;
  }

  private async fetchExperimentsSnapshot(): Promise<void> {
    if (!this.experimentsEnabled) {
      return;
    }
    const payload = await this.request("GET", "/api/v1/experiments", {
      query: { client_id: this.clientId, namespace_name: this.namespaceName ?? "" },
    });
    this.applyExperiments(payload);
  }

  private async pollExperimentsOnce(): Promise<void> {
    if (!this.experimentsEnabled) {
      return;
    }
    const payload = await this.request("POST", "/api/v1/experiments/poll", {
      body: { client_id: this.clientId, namespace_name: this.namespaceName ?? "" },
    });
    this.applyExperiments(payload);
  }

  /**
   * Replace the whole set rather than merging. The server sends every servable
   * experiment each time, so a replace is how a stopped experiment disappears
   * without needing a tombstone.
   */
  private applyExperiments(payload: unknown): void {
    const experiments =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).experiments
        : null;

    const next = new Map<string, ExperimentDefinition>();
    if (experiments && typeof experiments === "object") {
      for (const [key, raw] of Object.entries(experiments as Record<string, unknown>)) {
        if (raw && typeof raw === "object") {
          next.set(key, raw as ExperimentDefinition);
        }
      }
    }
    this.experiments = next;
    this.experimentsLoaded = true;
    this.markDirty();
  }

  /** Return a { name: document } copy of the watched configs' documents. */
  configsSnapshot(): Record<string, ConfigDocument> {
    const result: Record<string, ConfigDocument> = {};
    for (const [name, entry] of this.configs) {
      result[name] = entry.document;
    }
    return result;
  }

  /** Register a callback fired when the watched config `name` changes. Returns an unsubscribe function. */
  on(name: string, listener: ConfigChangeListener): () => void {
    let listeners = this.configListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.configListeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  /** Register a drain callback run when a requires_restart config changes. Returns an unsubscribe function. */
  onRestartRequired(listener: ConfigChangeListener): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  // --- Webhooks (server-side; Node embedded listener) ---

  /** The local URL the embedded webhook listener serves. */
  get webhookListenerUrl(): string {
    return `http://${this.webhookListenerHost}:${this.webhookListenerPort}${this.webhookListenerPath}`;
  }

  /** Count of every webhook POST processed, including duplicates. */
  get webhookEventsReceived(): number {
    return this.webhookEventsReceivedCount;
  }

  /**
   * Register (or re-register) a webhook per flagset with the server.
   * Already-existing registrations are treated as success.
   */
  async registerWebhooks(): Promise<void> {
    for (const flagset of this.flagsets) {
      const body: Record<string, unknown> = {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        webhook_name: `${this.webhookNamePrefix}-${flagset}`,
        flagset,
        target_url: this.webhookTargetUrl,
        secret: this.webhookSecret,
      };
      const namespace = this.flagsetNamespaces[flagset];
      if (namespace) {
        body["namespace_name"] = namespace;
      }

      try {
        await this.request("POST", "/api/v1/webhook", { body });
      } catch (error) {
        if (error instanceof GooseSDKHTTPError) {
          if (error.statusCode === 409) {
            continue;
          }
          if (
            error.statusCode === 400 &&
            (error.responseText.toLowerCase().includes("already exists") ||
              error.responseText.trim() === "")
          ) {
            continue;
          }
        }
        throw error;
      }
    }
  }

  /**
   * Apply a webhook delta. When `receivedSecret` is provided it is compared (in
   * constant time) against the configured webhook secret. Use this directly only
   * if you run your own HTTP handler instead of the embedded listener; deltas are
   * deduped by eventId, so repeated deliveries are safe.
   */
  processWebhookEvent(payload: RawFlag, receivedSecret?: string): void {
    if (receivedSecret !== undefined && !constantTimeEquals(receivedSecret, this.webhookSecret)) {
      throw new GooseSDKError("invalid webhook secret");
    }
    this.applyDelta(payload, "");
    this.webhookEventsReceivedCount += 1;
  }

  private async fetchConfigsSnapshot(): Promise<void> {
    // App config read: secret-bearing (documents may carry resolved secrets).
    const entries = await this.requestConfigs("GET", "/api/v1/configs", true);
    this.applyConfigs(entries, true);
  }

  private async pollConfigsOnce(): Promise<void> {
    const entries = await this.requestConfigs("POST", "/api/v1/configs/poll", false);
    this.applyConfigs(entries, false);
  }

  private async requestConfigs(
    method: "GET" | "POST",
    path: string,
    asQuery: boolean,
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      namespace_name: this.namespaceName,
      names: this.configNames,
    };

    let parsed: unknown;
    if (asQuery) {
      // GET: client_id/secret/namespace as query params, names repeated.
      const search = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        namespace_name: this.namespaceName ?? "",
      });
      for (const name of this.configNames) {
        search.append("names", name);
      }
      parsed = await this.request(method, `${path}?${search.toString()}`);
    } else {
      parsed = await this.request(method, path, { body: params });
    }

    const result = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const configs = result["configs"];
    return configs && typeof configs === "object" ? (configs as Record<string, unknown>) : {};
  }

  /**
   * Apply a batch of named config documents. For each watched name present, the
   * incoming document is diffed against the cached one; a difference (or a newly
   * seen name) produces a ConfigChangeEvent whose applyStrategy is
   * requires_restart when any changed inner entry requires a restart. On the
   * initial seed the cache is populated without dispatching listeners.
   */
  private applyConfigs(entries: Record<string, unknown>, initial: boolean): void {
    const changes: ConfigChangeEvent[] = [];
    let batchRequiresRestart = false;

    for (const name of this.configNames) {
      const incoming = entries[name];
      if (!incoming || typeof incoming !== "object") {
        continue;
      }
      const incomingRecord = incoming as Record<string, unknown>;
      const newDoc = incomingRecord["document"];
      if (!newDoc || typeof newDoc !== "object") {
        continue;
      }
      const revision = Number(incomingRecord["revision_number"] ?? 0) || 0;

      const current = this.configs.get(name);
      const oldDoc = current ? current.document : null;

      if (!current || !deepEquals(oldDoc, newDoc)) {
        // Reported on first sight and on each change, not on every poll, so an
        // unsatisfied entry does not flood onError once per interval.
        const unsatisfied = unsatisfiedRequiredEntries(newDoc as ConfigDocument, this.appVersion);
        if (unsatisfied.length > 0) {
          this.emitError(
            new GooseSDKError(
              `config '${name}': required entries resolve to nothing for app version ` +
                `'${this.appVersionRaw}': ${unsatisfied.join(", ")}`,
            ),
          );
        }

        const requiresRestart = this.changedConfigEntries(oldDoc, newDoc as ConfigDocument).some(
          (strategy) => strategy === "requires_restart",
        );
        if (requiresRestart) {
          batchRequiresRestart = true;
        }
        changes.push({
          name,
          oldValue: oldDoc,
          newValue: newDoc as ConfigDocument,
          applyStrategy: requiresRestart ? "requires_restart" : "immediate",
        });
      }

      this.configs.set(name, { document: newDoc as ConfigDocument, revision });
    }

    if (changes.length > 0) {
      this.markDirty();
    }

    if (initial) {
      return;
    }

    for (const change of changes) {
      const listeners = this.configListeners.get(change.name);
      if (!listeners) {
        continue;
      }
      for (const listener of listeners) {
        try {
          listener(change);
        } catch (error) {
          console.warn(`goose-sdk: config listener for '${change.name}' failed:`, error);
        }
      }
    }

    if (!batchRequiresRestart) {
      return;
    }
    const restartChange = changes.find((change) => change.applyStrategy === "requires_restart");
    if (restartChange) {
      for (const listener of this.restartListeners) {
        try {
          listener(restartChange);
        } catch (error) {
          console.warn("goose-sdk: restart-required drain callback failed:", error);
        }
      }
    }
    if (this.restartOnRequiredChange) {
      raiseRestartSignal();
    }
  }

  /**
   * Return the apply_strategy of every inner entry in newDoc whose value or
   * apply_strategy differs from oldDoc (or is newly added). A null oldDoc treats
   * every inner entry as changed.
   */
  private changedConfigEntries(oldDoc: ConfigDocument | null, newDoc: ConfigDocument): string[] {
    const newEntries = newDoc["configs"];
    if (!newEntries || typeof newEntries !== "object") {
      return [];
    }
    const oldEntriesRaw = oldDoc ? oldDoc["configs"] : null;
    const oldEntries =
      oldEntriesRaw && typeof oldEntriesRaw === "object" ? (oldEntriesRaw as Record<string, unknown>) : {};

    const changed: string[] = [];
    for (const [key, rawNew] of Object.entries(newEntries as Record<string, unknown>)) {
      const newEntry = (rawNew && typeof rawNew === "object" ? rawNew : {}) as Record<string, unknown>;
      // An entry gated out of this build's version range must not drag the
      // process through a requires_restart it never reads.
      if (!configEntryApplies(newEntry, this.appVersion)) {
        continue;
      }
      const strategy = String(newEntry["apply_strategy"] ?? "").trim();
      const oldEntryRaw = oldEntries[key];
      const oldEntry =
        oldEntryRaw && typeof oldEntryRaw === "object" ? (oldEntryRaw as Record<string, unknown>) : null;
      if (
        oldEntry === null ||
        !deepEquals(oldEntry["value"], newEntry["value"]) ||
        String(oldEntry["apply_strategy"] ?? "").trim() !== strategy
      ) {
        changed.push(strategy);
      }
    }
    return changed;
  }

  private async startWebhookListener(): Promise<void> {
    if (this.webhookServer) {
      return;
    }
    // Loaded at runtime so browser bundles never resolve a Node module. The
    // non-literal specifier keeps bundlers from statically following it.
    const httpSpecifier = "node:http";
    let http: {
      createServer: (handler: (req: any, res: any) => void) => {
        listen: (port: number, host: string, cb: () => void) => void;
        close: (cb?: () => void) => void;
        on: (event: string, cb: (err: unknown) => void) => void;
      };
    };
    try {
      http = (await import(/* @vite-ignore */ httpSpecifier)) as typeof http;
    } catch (error) {
      throw new GooseSDKError(
        `webhook mode requires a Node-compatible runtime with node:http (${String(error)})`,
      );
    }

    const server = http.createServer((req, res) => {
      void this.handleWebhookRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.on("error", (error: unknown) => {
        reject(
          new GooseSDKError(
            `failed to start embedded webhook listener on ${this.webhookListenerHost}:${this.webhookListenerPort}: ${String(error)}`,
          ),
        );
      });
      server.listen(this.webhookListenerPort, this.webhookListenerHost, () => resolve());
    });

    this.webhookServer = server;
  }

  private async handleWebhookRequest(req: any, res: any): Promise<void> {
    const url = typeof req.url === "string" ? req.url : "";
    const path = url.split("?")[0];
    if (req.method !== "POST" || path !== this.webhookListenerPath) {
      res.statusCode = req.method !== "POST" ? 405 : 404;
      res.end();
      return;
    }

    let raw = "";
    req.setEncoding?.("utf-8");
    req.on("data", (chunk: unknown) => {
      raw += typeof chunk === "string" ? chunk : String(chunk);
    });
    await new Promise<void>((resolve) => req.on("end", () => resolve()));

    let payload: RawFlag;
    try {
      payload = JSON.parse(raw) as RawFlag;
    } catch {
      res.statusCode = 400;
      res.end("invalid json payload");
      return;
    }

    try {
      const receivedSecret = req.headers?.["x-webhook-secret"];
      this.processWebhookEvent(payload, typeof receivedSecret === "string" ? receivedSecret : undefined);
    } catch (error) {
      if (error instanceof GooseSDKError && error.message === "invalid webhook secret") {
        res.statusCode = 401;
        res.end("invalid webhook secret");
        return;
      }
      console.warn("goose-sdk: embedded webhook processing failed:", error);
      res.statusCode = 400;
      res.end(String(error));
      return;
    }
    res.statusCode = 200;
    res.end("ok");
  }

  private stopWebhookListener(): void {
    if (!this.webhookServer) {
      return;
    }
    this.webhookServer.close();
    this.webhookServer = null;
  }

  private async evaluateRollout(
    flagKey: string,
    rollout: RolloutConfig,
    targetingKey: string | undefined,
    baseline: FlagValue,
    dataType: string,
  ): Promise<FlagValue> {
    const key = targetingKey ?? this.defaultTargetingKey;
    if (!key) {
      console.warn(
        `goose-sdk: flag '${flagKey}' has a canary rollout but no targetingKey was provided; returning the baseline value`,
      );
      return baseline;
    }
    const bucket = await bucketUser(rollout.salt ?? "", flagKey, String(key));
    if (bucket < (rollout.percentage ?? 0)) {
      if (rollout.value === undefined || rollout.value === null) {
        return baseline;
      }
      return coerceValue(rollout.value, dataType);
    }
    return baseline;
  }

  private resolveFlagset(flagset: string | undefined): string {
    if (flagset !== undefined) {
      return flagset;
    }
    if (this.flagsets.length !== 1) {
      throw new GooseSDKError("flagset is required when multiple flagsets are configured");
    }
    return this.flagsets[0];
  }

  private async fetchConfigSnapshot(flagset: string): Promise<Record<string, unknown>> {
    // Flag read: client_id only (no secret).
    const query: Record<string, string> = {
      client_id: this.clientId,
      flagset,
    };
    const namespace = this.flagsetNamespaces[flagset];
    if (namespace) {
      query["namespace_name"] = namespace;
    }

    const parsed = await this.request("GET", "/api/v1/config", { query });
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  private async pollOnce(flagset: string): Promise<void> {
    const cursor = this.pollCursors.get(flagset) ?? 0;
    const body: Record<string, unknown> = {
      client_id: this.clientId,
      flagset,
      timestamp: cursor,
    };
    const namespace = this.flagsetNamespaces[flagset];
    if (namespace) {
      body["namespace_name"] = namespace;
    }

    const parsed = await this.request("POST", "/api/v1/poll", { body });
    const result = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const flags = Array.isArray(result["flags"]) ? (result["flags"] as RawFlag[]) : [];

    let maxTimestamp = cursor;
    for (const rawFlag of flags) {
      const flagKey = String(rawFlag["flag_key"] ?? "").trim();
      if (!flagKey) {
        continue;
      }
      const updatedAt = toUnixSeconds(String(rawFlag["updated_at"] ?? ""));
      if (updatedAt !== null) {
        maxTimestamp = Math.max(maxTimestamp, updatedAt);
      }
      const dataType = String(rawFlag["flag_data_type"] ?? "").trim();
      this.commitFlag(flagset, flagKey, dataType, rawFlag["flag_value"], extractRollout(rawFlag),
        parseSegmentTargeting(rawFlag as Record<string, unknown>));
    }

    this.pollCursors.set(flagset, maxTimestamp);
  }

  private async pollingLoop(): Promise<void> {
    while (!this.stopped) {
      await this.sleep(this.pollIntervalSeconds * 1000);
      if (this.stopped) {
        break;
      }
      for (const flagset of this.flagsets) {
        try {
          await this.pollOnce(flagset);
          this.recordSuccess();
        } catch (error) {
          if (!this.stopped) {
            console.warn(`goose-sdk: poll failed for flagset ${flagset}:`, error);
            this.recordFailure(error);
            await this.honorRetryAfter(error);
          }
        }
      }
      if (this.configNames.length > 0) {
        try {
          await this.pollConfigsOnce();
        await this.pollExperimentsOnce();
        } catch (error) {
          if (!this.stopped) {
            console.warn("goose-sdk: config poll failed:", error);
            this.recordFailure(error);
            await this.honorRetryAfter(error);
          }
        }
      }
    }
  }

  private async sseLoop(flagset: string): Promise<void> {
    const payload: Record<string, unknown> = {
      clientId: this.clientId,
      flagSet: flagset,
    };
    const namespace = this.flagsetNamespaces[flagset];
    if (namespace) {
      payload["namespaceName"] = namespace;
    }

    const backoff = new Backoff(1000, 30_000);
    let failures = 0;
    while (!this.stopped) {
      const start = Date.now();
      let error: unknown = null;
      try {
        await this.consumeSseStream(payload, flagset);
      } catch (caught) {
        error = caught;
      }
      if (this.stopped) {
        break;
      }

      // A stream that stayed up for a healthy interval counts as recovered.
      if (Date.now() - start >= SSE_STABLE_INTERVAL_MS) {
        backoff.reset();
        failures = 0;
        this.markSseUp(flagset);
      }

      if (error !== null) {
        this.recordFailure(error);
        console.warn(`goose-sdk: sse loop disconnected for flagset ${flagset}:`, error);
      }

      failures += 1;
      if (failures >= SSE_FALLBACK_THRESHOLD) {
        this.markSseDown(flagset);
      }

      let delay = backoff.durationMs();
      const retryAfterMs = error instanceof GooseSDKHTTPError ? error.retryAfter * 1000 : 0;
      if (retryAfterMs > delay) {
        delay = retryAfterMs;
      }
      await this.sleep(delay);
    }
  }

  private async consumeSseStream(payload: Record<string, unknown>, fallbackFlagset: string): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    // Idle watchdog: if the server sends nothing (not even a ~20s keepalive)
    // within sseReadTimeout, abort so the loop reconnects instead of hanging on
    // a silently half-open connection.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    // Abort with an explicit reason and settle the reader on teardown so an
    // aborted read never surfaces as an unhandled rejection on reconnect.
    const abort = () => controller.abort(new GooseSDKError("sse idle timeout"));
    const armWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
      }
      watchdog = setTimeout(abort, this.sseReadTimeoutSeconds * 1000);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      armWatchdog();
      const response = await fetch(`${this.serverUrl}/api/v1/sse`, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          [sdkClientThumbprintHeader]: await this.thumbprint(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new GooseSDKHTTPError(
          response.status,
          `sse request failed (${response.status})`,
          text,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }
      if (!response.body) {
        throw new GooseSDKError("sse response has no body stream");
      }

      // Connected: the client is receiving updates again.
      this.recordSuccess();

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let block: string[] = [];

      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        armWatchdog(); // reset the idle deadline on data
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          if (line === "") {
            this.handleSseBlock(block, fallbackFlagset);
            block = [];
          } else {
            block.push(line);
          }
        }
      }

      if (block.length > 0) {
        this.handleSseBlock(block, fallbackFlagset);
      }
    } finally {
      if (watchdog) {
        clearTimeout(watchdog);
      }
      // Release the stream; swallow the abort-driven rejection so it never
      // escapes as an unhandled rejection.
      if (reader) {
        reader.cancel().catch(() => {});
      }
      this.abortControllers.delete(controller);
    }
  }

  private handleSseBlock(block: string[], fallbackFlagset: string): void {
    if (block.length === 0) {
      return;
    }
    const dataLines = block
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) {
      return;
    }

    let payload: RawFlag;
    try {
      payload = JSON.parse(dataLines.join("\n")) as RawFlag;
    } catch {
      console.warn("goose-sdk: skipping invalid sse payload");
      return;
    }
    this.applyDelta(payload, fallbackFlagset);
  }

  private applySnapshot(flagset: string, flags: RawFlag[]): void {
    for (const rawFlag of flags) {
      const flagKey = String(rawFlag["flag_key"] ?? "").trim();
      if (!flagKey) {
        continue;
      }
      const dataType = String(rawFlag["flag_data_type"] ?? "").trim();
      this.commitFlag(flagset, flagKey, dataType, rawFlag["flag_value"], extractRollout(rawFlag),
        parseSegmentTargeting(rawFlag as Record<string, unknown>));
    }
  }

  private applyDelta(payload: RawFlag, fallbackFlagset: string): void {
    const eventId = String(payload["eventId"] ?? payload["event_id"] ?? "").trim();
    if (eventId && this.isDuplicateEvent(eventId)) {
      return;
    }

    const flagset = String(payload["flagSet"] ?? payload["flag_set"] ?? fallbackFlagset ?? "").trim();
    const flagKey = String(payload["flagKey"] ?? payload["flag_key"] ?? "").trim();
    if (!flagset || !flagKey) {
      return;
    }
    if (!this.flags.has(flagset)) {
      return;
    }

    const dataType = this.flagDataTypes.get(flagset)?.get(flagKey) ?? "";
    // A delta with no percentage means canary was disabled, so this clears it.
    // A malformed value is rejected, retaining the last-known-good value.
    this.commitFlag(flagset, flagKey, dataType, payload["flagValue"] ?? payload["flag_value"],
      extractRollout(payload), parseSegmentTargeting(payload as Record<string, unknown>));
    this.recordSuccess();
  }

  private isDuplicateEvent(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) {
      // Refresh recency so a later redelivery does not clobber a newer value.
      this.seenEventIds.delete(eventId);
      this.seenEventIds.add(eventId);
      return true;
    }
    this.seenEventIds.add(eventId);
    while (this.seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seenEventIds.delete(oldest);
    }
    return false;
  }

  private setFlag(flagset: string, flagKey: string, value: FlagValue): void {
    const values = this.flags.get(flagset);
    if (!values) {
      return;
    }
    const previousValue = values.has(flagKey) ? values.get(flagKey) : undefined;
    values.set(flagKey, value);

    this.persist(flagset, flagKey, value);
    this.markDirty();

    if (previousValue !== value) {
      this.notifyChange({ flagset, flagKey, value, previousValue });
    }
  }

  private persist(flagset: string, flagKey: string, value: FlagValue): void {
    if (!this.storageAdapter) {
      return;
    }
    try {
      this.storageAdapter.createOrUpdate(flagset, flagKey, value);
    } catch (error) {
      console.warn("goose-sdk: storageAdapter.createOrUpdate failed:", error);
    }
  }

  private notifyChange(change: FlagChange): void {
    for (const listener of this.changeListeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn("goose-sdk: onChange listener failed:", error);
      }
    }
  }

  private maxUpdatedTimestamp(flags: RawFlag[]): number | null {
    let max: number | null = null;
    for (const rawFlag of flags) {
      const parsed = toUnixSeconds(String(rawFlag["updated_at"] ?? ""));
      if (parsed === null) {
        continue;
      }
      if (max === null || parsed > max) {
        max = parsed;
      }
    }
    return max;
  }

  private buildFlagsetNamespaces(mapping: Record<string, string> | undefined): Record<string, string> {
    const normalized: Record<string, string> = {};
    if (mapping) {
      for (const [rawFlagset, rawNamespace] of Object.entries(mapping)) {
        const flagset = rawFlagset.trim();
        const namespace = normalizeNamespace(rawNamespace);
        if (!flagset || namespace === null) {
          continue;
        }
        if (!this.flagsets.includes(flagset)) {
          throw new GooseSDKError(`flagsetNamespaces includes unknown flagset '${flagset}'`);
        }
        normalized[flagset] = namespace;
      }
    }
    if (this.namespaceName !== null) {
      for (const flagset of this.flagsets) {
        if (!(flagset in normalized)) {
          normalized[flagset] = this.namespaceName;
        }
      }
    }
    return normalized;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    { query, body }: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    let url = `${this.serverUrl}${path}`;
    if (query) {
      const search = new URLSearchParams(query).toString();
      if (search) {
        url += `?${search}`;
      }
    }

    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutSeconds * 1000);

    try {
      const thumbprint = await this.thumbprint();
      const response = await fetch(url, {
        method,
        headers:
          body !== undefined
            ? {
                "Content-Type": "application/json",
                Accept: "application/json",
                [sdkClientThumbprintHeader]: thumbprint,
              }
            : {
                Accept: "application/json",
                [sdkClientThumbprintHeader]: thumbprint,
              },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new GooseSDKHTTPError(
          response.status,
          `${method} ${path} failed (${response.status})`,
          text,
          parseRetryAfter(response.headers.get("Retry-After")),
        );
      }
      if (text.trim() === "") {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async thumbprint(): Promise<string> {
    return this.thumbprintPromise;
  }
}

function normalizeFlagsets(flagsets: string | string[]): string[] {
  const candidates = typeof flagsets === "string" ? [flagsets] : [...flagsets];
  const normalized: string[] = [];
  for (const item of candidates) {
    const value = String(item).trim();
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function normalizeConnectionTypes(
  connectionType: ConnectionType | ConnectionType[] | undefined,
): Set<ConnectionType> {
  if (connectionType === undefined) {
    return new Set<ConnectionType>(["polling"]);
  }
  const items = Array.isArray(connectionType) ? connectionType : [connectionType];
  const resolved = new Set<ConnectionType>();
  for (const item of items) {
    const normalized = String(item).trim().toLowerCase();
    if (normalized === "polling" || normalized === "sse" || normalized === "webhook") {
      resolved.add(normalized);
    } else {
      throw new GooseSDKError(
        `unsupported connectionType '${item}' (supported: 'polling', 'sse', 'webhook')`,
      );
    }
  }
  return resolved.size > 0 ? resolved : new Set<ConnectionType>(["polling"]);
}

function normalizeNamespace(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeThumbprint(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

async function resolveThumbprint(explicit: string | undefined, clientId: string): Promise<string> {
  const normalized = normalizeThumbprint(explicit);
  if (normalized) {
    return normalized;
  }

  const browserThumbprint = resolveBrowserThumbprint(clientId);
  if (browserThumbprint) {
    return browserThumbprint;
  }

  const runtimeSeed = await resolveRuntimeThumbprintSeed(clientId);
  return `gth_${await sha256Hex(runtimeSeed)}`;
}

function resolveBrowserThumbprint(clientId: string): string | null {
  const storage = safeLocalStorage();
  if (!storage) {
    return null;
  }
  const key = `goose-sdk-thumbprint:${clientId}`;
  const existing = normalizeThumbprint(storage.getItem(key));
  if (existing) {
    return existing;
  }
  const created = `gth_${randomTokenHex(24)}`;
  try {
    storage.setItem(key, created);
  } catch {
    // Ignore storage write failures and still use the generated value.
  }
  return created;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveRuntimeThumbprintSeed(clientId: string): Promise<string> {
  const runtime = (globalThis as {
    navigator?: { userAgent?: string; platform?: string };
    process?: {
      argv?: string[];
      env?: Record<string, string | undefined>;
      release?: { name?: string };
      title?: string;
      versions?: Record<string, string | undefined>;
    };
  }).process;
  const nav = (globalThis as { navigator?: { userAgent?: string; platform?: string } }).navigator;

  if (!runtime) {
    const cached = fallbackRuntimeThumbprints.get(clientId);
    if (cached) {
      return cached;
    }
    const created = [
      "js",
      clientId,
      nav?.userAgent ?? "",
      nav?.platform ?? "",
      randomTokenHex(16),
    ].join("|");
    fallbackRuntimeThumbprints.set(clientId, created);
    return created;
  }

  let hostname = runtime.env?.HOSTNAME ?? runtime.env?.COMPUTERNAME ?? "";
  try {
    const osSpecifier = "node:os";
    const osModule = (await import(/* @vite-ignore */ osSpecifier)) as { hostname?: () => string };
    if (typeof osModule.hostname === "function") {
      hostname = hostname || osModule.hostname();
    }
  } catch {
    // Ignore host lookup failures and fall back to process metadata.
  }

  const executable = runtime.argv?.[1] ?? "";
  const title = runtime.title ?? "";
  const runtimeName = runtime.release?.name ?? "";

  return ["js", clientId, hostname, executable, title, runtimeName].join("|");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function randomTokenHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Derive the embedded listener path: explicit override, else the target URL's path, else "/webhook". */
function resolveWebhookPath(explicit: string | undefined, targetUrl: string | null): string {
  let path = (explicit ?? "").trim();
  if (!path && targetUrl) {
    try {
      path = new URL(targetUrl).pathname;
    } catch {
      path = "";
    }
  }
  if (!path) {
    path = "/webhook";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

/** Generate a URL-safe random webhook secret (Web Crypto, available in browsers and Node 18+). */
function generateWebhookSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison, to avoid leaking the webhook secret via timing. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Structural equality for JSON-shaped config documents/values. */
/**
 * Parse a lenient dotted version ("3", "2.4", "2.4.1", "v2.4.1-rc.1") into its
 * numeric components. A leading "v" is dropped and any pre-release or build
 * suffix is ignored: app-version gating is coarse by design. Returns null when
 * a component is not a number. Mirrors parseAppVersion in core_service/configs.go.
 */
function parseAppVersion(raw: string): number[] | null {
  let trimmed = raw.trim().replace(/^v/, "");
  const suffix = trimmed.search(/[-+]/);
  if (suffix >= 0) {
    trimmed = trimmed.slice(0, suffix);
  }
  trimmed = trimmed.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const components: number[] = [];
  for (const part of trimmed.split(".")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 0) {
      return null;
    }
    components.push(n);
  }
  return components;
}

/** Order two parsed versions, padding the shorter so "2.4" equals "2.4.0". */
function compareAppVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Whether an entry's min_app_version / max_app_version range (both inclusive)
 * includes appVersion. Every unknown fails open — a null appVersion, an absent
 * bound, or an unparseable one leaves the entry applying — so bad metadata
 * degrades to the ungated behaviour rather than silently hiding a value.
 */
function configEntryApplies(entry: Record<string, unknown>, appVersion: number[] | null): boolean {
  if (appVersion === null) {
    return true;
  }
  const lowerRaw = entry["min_app_version"];
  if (typeof lowerRaw === "string") {
    const lower = parseAppVersion(lowerRaw);
    if (lower !== null && compareAppVersions(appVersion, lower) < 0) {
      return false;
    }
  }
  const upperRaw = entry["max_app_version"];
  if (typeof upperRaw === "string") {
    const upper = parseAppVersion(upperRaw);
    if (upper !== null && compareAppVersions(appVersion, upper) > 0) {
      return false;
    }
  }
  return true;
}

/**
 * What an entry resolves to for appVersion: its `value` when the entry applies,
 * otherwise its `default`. `found` is false when neither is present, leaving
 * the caller to use its own fallback.
 */
function resolveConfigEntry(
  entry: Record<string, unknown>,
  appVersion: number[] | null,
): { value: unknown; found: boolean } {
  const key = configEntryApplies(entry, appVersion) ? "value" : "default";
  return key in entry ? { value: entry[key], found: true } : { value: undefined, found: false };
}

/**
 * Entries in doc marked `required` that resolve to nothing for appVersion —
 * typically one gated out of this build's version range with no default to fall
 * back on. Reported through onError so the mistake surfaces at startup rather
 * than at the first read.
 */
function unsatisfiedRequiredEntries(doc: ConfigDocument, appVersion: number[] | null): string[] {
  const entries = doc["configs"];
  if (!entries || typeof entries !== "object") {
    return [];
  }
  const unsatisfied: string[] = [];
  for (const [key, rawEntry] of Object.entries(entries as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry["required"] !== true) {
      continue;
    }
    const resolved = resolveConfigEntry(entry, appVersion);
    if (!resolved.found || resolved.value === null) {
      unsatisfied.push(key);
    }
  }
  return unsatisfied.sort();
}

/**
 * A copy of doc with the `value` and `default` of every entry marked
 * `sensitive` dropped. Config values arrive with ${secret} references already
 * resolved server-side, so persisting a document verbatim would write plaintext
 * secrets to the cache; marking an entry sensitive keeps it in memory only.
 * Such an entry reads as absent after a warm start, until the first fetch
 * repopulates it.
 */
function redactSensitiveConfigEntries(doc: ConfigDocument): ConfigDocument {
  const entries = doc["configs"];
  if (!entries || typeof entries !== "object") {
    return doc;
  }
  const entriesRecord = entries as Record<string, unknown>;
  let redactedEntries: Record<string, unknown> | null = null;
  for (const [key, rawEntry] of Object.entries(entriesRecord)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    if (entry["sensitive"] !== true) {
      continue;
    }
    redactedEntries ??= { ...entriesRecord };
    const { value: _value, default: _default, ...rest } = entry;
    redactedEntries[key] = rest;
  }
  return redactedEntries === null ? doc : { ...doc, configs: redactedEntries };
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => key in bRecord && deepEquals(aRecord[key], bRecord[key]));
}

/**
 * Raise SIGINT so an orchestrator restarts the process after a requires_restart
 * config change. Node-only; a no-op (with a warning) where `process` is absent.
 */
function raiseRestartSignal(): void {
  const proc = (globalThis as { process?: { pid?: number; kill?: (pid: number, signal: string) => void } }).process;
  if (proc && typeof proc.kill === "function" && typeof proc.pid === "number") {
    console.info("goose-sdk: requires_restart config changed; raising SIGINT for orchestrator restart");
    proc.kill(proc.pid, "SIGINT");
  } else {
    console.warn("goose-sdk: restartOnRequiredChange is set but no process to signal in this runtime");
  }
}

/** Factory helper for constructing a GooseSDK client. */
export function createClient(options: GooseClientOptions): GooseSDK {
  return new GooseSDK(options);
}

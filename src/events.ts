/**
 * Exposure and conversion reporting for the browser.
 *
 * Events are deduplicated, buffered and flushed in batches, so a `getVariant`
 * in a render path costs a map lookup rather than a request. Two browser
 * realities shape the design:
 *
 *  - A tab can be closed at any moment, so the queue flushes on
 *    `visibilitychange` via `sendBeacon`, which survives unload where `fetch`
 *    does not.
 *  - Losing an exposure shrinks a denominator and losing a conversion shrinks a
 *    numerator. Neither loss is uniform across arms, so both bias the result
 *    rather than merely adding noise. Drops are therefore counted, and a
 *    dropped exposure forgets its dedup key so the subject is reported again.
 */

export const EXPERIMENT_EVENT_FLUSH_SIZE = 50;
export const EXPERIMENT_EVENT_FLUSH_INTERVAL_MS = 5000;
export const EXPERIMENT_EVENT_QUEUE_CAP = 1000;
export const EXPOSURE_DEDUP_ENTRIES = 10000;

export interface ExperimentEvent {
  event_id: string;
  type: "exposure" | "conversion";
  experiment_key: string;
  variant_key?: string;
  metric_key?: string;
  value?: number;
  targeting_key: string;
  occurred_at: string;
}

/** Mint the idempotency key the ingest consumer deduplicates on. */
export function newEventId(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  if (globalCrypto && typeof globalCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalCrypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Last resort: still unique enough for dedup inside the consumer's 24h window.
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * A bounded insertion-ordered set. Used to report each subject's exposure once
 * rather than on every render.
 */
export class BoundedKeySet {
  private readonly keys = new Set<string>();

  constructor(private readonly max: number) {}

  /** Record a key and report whether it had already been seen. */
  seen(key: string): boolean {
    if (this.keys.has(key)) {
      return true;
    }
    this.keys.add(key);
    if (this.keys.size > this.max) {
      // Set iteration is insertion-ordered, so the first entry is the oldest.
      const oldest = this.keys.values().next();
      if (!oldest.done) {
        this.keys.delete(oldest.value);
      }
    }
    return false;
  }

  /**
   * Forget a key, so the next read reports it again. Called when a buffered
   * exposure is dropped before reaching the server — without this the subject
   * would be missing from the denominator for the life of the page.
   */
  forget(key: string): void {
    this.keys.delete(key);
  }

  get size(): number {
    return this.keys.size;
  }
}

/** What the queue needs from its owner to actually send a batch. */
export interface EventSink {
  send(events: ExperimentEvent[]): Promise<void>;
  /**
   * Fire-and-forget send used on page hide, where there is no time to await a
   * response. Returns false when the runtime cannot do it (no sendBeacon), in
   * which case the caller falls back to a keepalive fetch.
   */
  sendBeacon?(events: ExperimentEvent[]): boolean;
  onDrop?(event: ExperimentEvent, reason: string): void;
}

/**
 * Buffers events and flushes them on size, on an interval, on page hide and on
 * close.
 */
export class ExperimentEventQueue {
  private queue: ExperimentEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private dropped = 0;
  private closed = false;

  constructor(private readonly sink: EventSink) {}

  start(): void {
    if (this.timer !== null || this.closed) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, EXPERIMENT_EVENT_FLUSH_INTERVAL_MS);
    // Node's timers keep the process alive; a background flush should not.
    (this.timer as unknown as { unref?: () => void }).unref?.();

    // A closing tab gets no async work, so the last batch rides out on
    // sendBeacon. Without this, everything buffered since the last flush is
    // lost exactly when a session ends — which is when conversions happen.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      this.visibilityHandler = () => {
        if (document.visibilityState === "hidden") {
          this.flushOnHide();
        }
      };
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get pending(): readonly ExperimentEvent[] {
    return this.queue;
  }

  /**
   * Buffer an event. `onOverflow` is called with the dropped event so the
   * caller can forget its dedup key.
   */
  enqueue(event: ExperimentEvent, onOverflow?: (event: ExperimentEvent) => void): void {
    if (this.closed) {
      return;
    }
    if (this.queue.length >= EXPERIMENT_EVENT_QUEUE_CAP) {
      this.dropped += 1;
      onOverflow?.(event);
      this.sink.onDrop?.(event, "queue full");
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= EXPERIMENT_EVENT_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** Send everything buffered. Safe to call when empty. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];

    try {
      await this.sink.send(batch);
    } catch (error) {
      // Put the batch back so the next flush retries, but respect the cap: an
      // unreachable server must not grow the queue without bound.
      const room = Math.max(0, EXPERIMENT_EVENT_QUEUE_CAP - this.queue.length);
      const kept = batch.slice(0, room);
      const lost = batch.length - kept.length;
      this.queue = [...kept, ...this.queue];
      if (lost > 0) {
        this.dropped += lost;
        this.sink.onDrop?.(batch[batch.length - 1], `flush failed, ${lost} dropped`);
      }
      throw error;
    }
  }

  /** Best-effort synchronous flush for page hide. */
  flushOnHide(): void {
    if (this.queue.length === 0) {
      return;
    }
    const batch = this.queue;
    this.queue = [];
    if (this.sink.sendBeacon?.(batch)) {
      return;
    }
    // No beacon available: try anyway and accept that it may not land.
    void this.sink.send(batch).catch(() => {
      this.dropped += batch.length;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    try {
      await this.flush();
    } catch {
      // A failed final flush is already counted; closing must not throw.
    }
  }
}

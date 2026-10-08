import type { FlagValue } from "./client.js";

/**
 * Stores the SDK's last-known-good state so a process that restarts during a
 * config-service outage can serve real values immediately instead of booting
 * with an empty cache. The SDK reads it once on connect (before any network
 * call) and writes a debounced snapshot as values change.
 *
 * Node-only in practice (a browser has no filesystem); browser apps simply omit
 * a cache. Implementations may be async.
 */
export interface PersistentCache {
  /** Return the last saved snapshot, or null when nothing is stored. */
  load(): Promise<Snapshot | null>;
  /** Persist a snapshot, replacing any previous one. */
  save(snapshot: Snapshot): Promise<void>;
}

/** Serializable last-known-good state: enough to answer reads and resume polling. */
export interface Snapshot {
  flags: Record<string, Record<string, FlagValue>>;
  flagDataTypes: Record<string, Record<string, string>>;
  rollouts: Record<string, Record<string, RolloutSnapshot>>;
  pollCursors: Record<string, number>;
  configs: Record<string, ConfigSnapshot>;
}

export interface RolloutSnapshot {
  percentage: number | null;
  salt: string | null;
  value: FlagValue | undefined;
}

export interface ConfigSnapshot {
  document: Record<string, unknown>;
  revision: number;
}

/**
 * A PersistentCache backed by a single JSON file (Node only). Writes are atomic
 * (temp file + rename) so a crash mid-write never leaves a corrupt cache; a
 * missing file loads as null. `node:fs` is imported at runtime so browser
 * bundles never resolve it.
 */
// The node:fs/promises surface we use, kept `any` so the package needs no Node
// type dependency (matching the webhook listener's node:http loading).
interface NodeFs {
  readFile: (path: string, encoding: string) => Promise<string>;
  writeFile: (path: string, data: string, options: { mode: number }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
}

export class FileCache implements PersistentCache {
  constructor(private readonly path: string) {}

  private async fs(): Promise<NodeFs> {
    // Loaded at runtime so browser bundles never resolve a Node module. The
    // non-literal specifier keeps bundlers from statically following it.
    const specifier = "node:fs/promises";
    try {
      return (await import(/* @vite-ignore */ specifier)) as NodeFs;
    } catch (error) {
      throw new Error(`FileCache requires a Node-compatible runtime with node:fs (${String(error)})`);
    }
  }

  async load(): Promise<Snapshot | null> {
    const fs = await this.fs();
    let text: string;
    try {
      text = await fs.readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (text.trim() === "") {
      return null;
    }
    return JSON.parse(text) as Snapshot;
  }

  async save(snapshot: Snapshot): Promise<void> {
    const fs = await this.fs();
    const tmp = `${this.path}.${Math.floor(Date.now())}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }
}

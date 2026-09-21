import type { BucketState } from "@/lib/bucket/reducer";
import { deserializeState, serializeState } from "@/lib/bucket/persistence";
import { getDb, type D1Database } from "@/lib/server-env";

export interface BucketStore {
  load(sessionId: string): Promise<BucketState | null>;
  save(sessionId: string, state: BucketState): Promise<void>;
  /** Which implementation answered — surfaced in logs so dev/prod confusion is visible. */
  readonly kind: "d1" | "memory";
}

/** Cloudflare D1. The only store used in production. */
class D1BucketStore implements BucketStore {
  readonly kind = "d1" as const;

  constructor(private readonly db: D1Database) {}

  async load(sessionId: string): Promise<BucketState | null> {
    const row = await this.db
      .prepare("SELECT state FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ state: string }>();
    if (!row?.state) return null;
    return deserializeState(row.state);
  }

  async save(sessionId: string, state: BucketState): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO sessions (id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(sessionId, serializeState(state), now, now)
      .run();

    // Append-only mirror of confirmed purchases. The session blob is what the app reads
    // back; this table is what Phase 4's verdict logging and the evaluation set query.
    // INSERT OR IGNORE keyed on the transaction's own uuid makes re-saving idempotent
    // without tracking which rows are new.
    if (state.transactions.length > 0) {
      const statements = state.transactions.slice(0, 200).map((t) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO transactions
               (id, session_id, amount, label, bucket_id, intent, readiness_tag, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            t.id,
            sessionId,
            t.amount,
            t.label,
            t.bucketId,
            t.intent,
            t.readinessTag ?? null,
            t.timestamp,
          ),
      );
      await this.db.batch(statements);
    }
  }
}

/**
 * Dev-only store.
 *
 * `npm run dev` runs a plain Node Vite server, not the Workers runtime, so there is no
 * `env` and therefore no D1 binding — verified, not assumed. This keeps the dev loop
 * working; it is not a fallback that should ever run in production.
 *
 * Held on globalThis so state survives Vite's module reloads.
 */
class MemoryBucketStore implements BucketStore {
  readonly kind = "memory" as const;

  private get map(): Map<string, string> {
    const g = globalThis as { __bucketMemoryStore?: Map<string, string> };
    if (!g.__bucketMemoryStore) g.__bucketMemoryStore = new Map();
    return g.__bucketMemoryStore;
  }

  async load(sessionId: string): Promise<BucketState | null> {
    const raw = this.map.get(sessionId);
    return raw ? deserializeState(raw) : null;
  }

  async save(sessionId: string, state: BucketState): Promise<void> {
    this.map.set(sessionId, serializeState(state));
  }
}

export function getStore(): BucketStore {
  const db = getDb();
  return db ? new D1BucketStore(db) : new MemoryBucketStore();
}

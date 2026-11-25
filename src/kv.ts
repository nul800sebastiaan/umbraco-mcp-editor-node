/**
 * Cloudflare-KV-compatible store backed by SQLite (node:sqlite, no native build).
 *
 * Implements the subset of the KVNamespace API used by
 * @cloudflare/workers-oauth-provider and @umbraco-cms/mcp-hosted:
 * get (text/json), put (expirationTtl / expiration), delete, list (prefix, limit, cursor).
 *
 * NOTE: this database holds OAuth grants and encrypted Umbraco tokens. Keep the data
 * directory private (the Docker image runs as a non-root user and the file is chmod 600).
 */
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface PutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}
interface GetOptions {
  type?: "text" | "json" | "arrayBuffer" | "stream";
}
interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string | null;
}

// Loaded via require so bundlers (esbuild) do not strip the `node:` prefix from node:sqlite.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const now = () => Math.floor(Date.now() / 1000);

export class SqliteKV {
  private db: DatabaseSyncType;
  private sweeper: NodeJS.Timeout;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at);
    `);
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private sweep() {
    this.db.prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now());
  }

  async get(key: string, options?: GetOptions | string): Promise<any> {
    const type = typeof options === "string" ? options : (options?.type ?? "text");
    const row = this.db
      .prepare("SELECT value, expires_at FROM kv WHERE key = ?")
      .get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now()) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      return null;
    }
    if (type === "json") return JSON.parse(row.value);
    if (type === "arrayBuffer") return new TextEncoder().encode(row.value).buffer;
    return row.value;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: PutOptions): Promise<void> {
    const text = typeof value === "string" ? value : new TextDecoder().decode(value as ArrayBuffer);
    let expiresAt: number | null = null;
    if (options?.expiration) expiresAt = Math.floor(options.expiration);
    else if (options?.expirationTtl) expiresAt = now() + Math.max(60, Math.floor(options.expirationTtl));
    this.db
      .prepare(
        `INSERT INTO kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
           expires_at = excluded.expires_at, metadata = excluded.metadata`,
      )
      .run(key, text, expiresAt, options?.metadata === undefined ? null : JSON.stringify(options.metadata));
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  async list(options: ListOptions = {}) {
    const limit = Math.min(options.limit ?? 1000, 1000);
    const prefix = options.prefix ?? "";
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString() : "";
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(
        `SELECT key, expires_at, metadata FROM kv
         WHERE key LIKE ? ESCAPE '\\' AND key > ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .all(`${escaped}%`, after, now(), limit + 1) as Array<{
      key: string;
      expires_at: number | null;
      metadata: string | null;
    }>;
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires_at !== null ? { expiration: r.expires_at } : {}),
        ...(r.metadata !== null ? { metadata: JSON.parse(r.metadata) } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: Buffer.from(page[page.length - 1].key).toString("base64url") }),
      cacheStatus: null,
    };
  }

  close() {
    clearInterval(this.sweeper);
    this.db.close();
  }
}

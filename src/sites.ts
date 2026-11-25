/**
 * Multi-site registry for host-based routing.
 *
 * One backend process (one Umbraco major) can serve several Umbraco sites. The site is chosen
 * by the public hostname of the request (e.g. marketing.mcp.example.com), so each site's OAuth
 * redirect URI is simply https://<host>/callback, which is exactly what
 * Umbraco.Mcp.HostedAuth registers for a self-hosted client (Origins = https://<host>).
 *
 * Every site gets its own SQLite store, so OAuth clients, grants and Umbraco tokens never
 * mix between sites.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { SqliteKV } from "./kv.js";

export interface SiteEntry {
  host: string;
  baseUrl: string;
  clientId: string;
  serverUrl?: string;
  /** Umbraco major version of the site (selects the backend; checked again by the backend). */
  major: number;
}

function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

export class SiteRegistry {
  private sites = new Map<string, SiteEntry>();
  private mtimeMs = 0;
  private stores = new Map<string, SqliteKV>();

  constructor(
    private readonly file: string,
    private readonly dataDir: string,
  ) {
    this.reload();
  }

  private reload() {
    if (!existsSync(this.file)) {
      // Fine in dynamic-only setups: no fixed sites.
      this.sites = new Map();
      this.mtimeMs = 0;
      return;
    }
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { sites?: Array<Partial<SiteEntry>> };
    const next = new Map<string, SiteEntry>();
    for (const [i, raw] of (parsed.sites ?? []).entries()) {
      if (!raw.host || !raw.baseUrl || !raw.clientId || !Number.isInteger(raw.major)) {
        throw new Error(`${this.file}: sites[${i}] needs host, baseUrl, clientId and an integer "major"`);
      }
      const host = normaliseHost(raw.host);
      if (next.has(host)) throw new Error(`${this.file}: duplicate host ${host}`);
      next.set(host, {
        host,
        baseUrl: raw.baseUrl.replace(/\/+$/, ""),
        clientId: raw.clientId,
        serverUrl: raw.serverUrl?.replace(/\/+$/, ""),
        major: raw.major as number,
      });
    }
    this.sites = next;
    this.mtimeMs = statSync(this.file).mtimeMs;
  }

  /** Looks a site up by the request's Host (port included, then without the port). */
  resolve(host: string): SiteEntry | undefined {
    try {
      const mtime = existsSync(this.file) ? statSync(this.file).mtimeMs : 0;
      if (mtime !== this.mtimeMs) this.reload();
    } catch (error) {
      console.error("[sites] could not reload sites file, keeping previous config:", error);
    }
    const h = normaliseHost(host);
    return this.sites.get(h) ?? this.sites.get(h.replace(/:\d+$/, ""));
  }

  /** Per-site OAuth store. Only ever called with a host that came from the sites file. */
  kvFor(site: SiteEntry): SqliteKV {
    let store = this.stores.get(site.host);
    if (!store) {
      const safe = site.host.replace(/[^a-z0-9.-]/g, "_");
      store = new SqliteKV(`${this.dataDir}/site-${safe}.sqlite`);
      this.stores.set(site.host, store);
    }
    return store;
  }

  close() {
    for (const store of this.stores.values()) store.close();
  }
}

/**
 * Dynamic sites: the Umbraco site and its major version are encoded in the public hostname,
 * and a site is only served after a person has approved it in the admin page.
 *
 *   v18--releases--umbraco--com.mcp.example.com  ->  Umbraco 18 at https://releases.umbraco.com
 *
 * Rules: a leading "v<major>--", then the site's hostname with every dot written as "--".
 * Single hyphens stay hyphens. A DNS label is at most 63 characters, so very long site
 * hostnames do not fit; list those in sites.json instead.
 *
 * Approval is keyed on the Umbraco URL, not on the hostname: once https://releases.umbraco.com
 * is approved, any version of it (v17--..., v18--..., v19--...) is served without asking again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lookup } from "node:dns/promises";
import net from "node:net";

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const BLOCKED_SUFFIXES = ["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "arpa", "onion"];

/** Decodes `<v18--site--example--com>.<domain>[:port]`. Returns { ok:true, major, baseUrl, name } or { ok:false, reason }. */
export function decodeHost(hostHeader, domain) {
  const host = String(hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${String(domain).trim().toLowerCase()}`;
  if (!host.endsWith(suffix)) return { ok: false, reason: "not-dynamic" };

  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return { ok: false, reason: "not-dynamic" };

  const match = /^v(\d{1,3})--(.+)$/.exec(label);
  if (!match) return { ok: false, reason: "Hostname must start with the Umbraco major, e.g. v18--<site>--<tld>" };
  if (match[2].includes("---") || match[2].startsWith("-") || match[2].endsWith("-")) {
    return { ok: false, reason: "Malformed site name" };
  }

  const name = match[2].replaceAll("--", ".");
  const labels = name.split(".");
  if (name.length > 253 || labels.length < 2 || !labels.every((l) => l.length <= 63 && LABEL.test(l))) {
    return { ok: false, reason: "Malformed site name" };
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) || BLOCKED_SUFFIXES.includes(tld)) {
    return { ok: false, reason: "Site name is not a public hostname" };
  }
  return { ok: true, major: Number(match[1]), baseUrl: `https://${name}`, name };
}

/** True for addresses a public site could legitimately have. Blocks private, loopback, link-local, etc. */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]);
    if (v === "::" || v === "::1") return false;
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff")) return false;
    return true;
  }
  return false;
}

/** Throws unless the hostname resolves, and only to public addresses. */
export async function assertPublicHost(hostname) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`${hostname} does not resolve in DNS`);
  }
  if (!addresses.length) throw new Error(`${hostname} has no addresses`);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw new Error(`${hostname} resolves to a non-public address (${bad.address})`);
}

/** Approved sites and pending requests, persisted as JSON (atomic writes). */
export class DynamicStore {
  constructor(file, { maxPending = 100 } = {}) {
    this.file = file;
    this.maxPending = maxPending;
    this.approved = new Map(); // baseUrl -> { approvedAt }
    this.pending = new Map(); // baseUrl -> { majors:number[], firstSeen, lastSeen }
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(data.approved ?? {})) this.approved.set(k, v);
      for (const [k, v] of Object.entries(data.pending ?? {})) this.pending.set(k, v);
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ approved: Object.fromEntries(this.approved), pending: Object.fromEntries(this.pending) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  isApproved(baseUrl) {
    return this.approved.has(baseUrl);
  }

  /** Records an unapproved request. Returns false when the pending list is full and the site is new. */
  recordPending(baseUrl, major) {
    const now = new Date().toISOString();
    const existing = this.pending.get(baseUrl);
    if (existing) {
      if (!existing.majors.includes(major)) {
        existing.majors.push(major);
        existing.lastSeen = now;
        this.save();
      }
      return true;
    }
    if (this.pending.size >= this.maxPending) return false;
    this.pending.set(baseUrl, { majors: [major], firstSeen: now, lastSeen: now });
    this.save();
    return true;
  }

  approve(baseUrl) {
    if (!this.pending.has(baseUrl)) throw new Error("Not in the pending list");
    this.pending.delete(baseUrl);
    this.approved.set(baseUrl, { approvedAt: new Date().toISOString() });
    this.save();
  }

  deny(baseUrl) {
    if (this.pending.delete(baseUrl)) this.save();
  }

  remove(baseUrl) {
    if (this.approved.delete(baseUrl)) this.save();
  }
}

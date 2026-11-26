/**
 * Gateway: routes each public hostname to the Editor MCP backend that matches the Umbraco
 * major version of the site behind that hostname.
 *
 *   marketing.mcp.example.com -> site "marketing" (Umbraco 18) -> http://mcp-v18:8787
 *   intranet.mcp.example.com  -> site "intranet"  (Umbraco 17) -> http://mcp-v17:8787
 *
 * Zero dependencies (Node >= 22). Sites come from the same sites.json the backends read.
 * `major` is required per site: Umbraco does not expose its version anonymously
 * (/umbraco/management/api/v1/server/information needs a login), so it cannot be detected here.
 *
 * The gateway is meant to sit behind a TLS-terminating proxy (Caddy) and to be the ONLY thing
 * that can reach the backends. It forwards X-Forwarded-Host/Proto, which the backends trust.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { DynamicStore, appsettingsSnippet, decodeHost } from "./dynamic.mjs";
import { startAdmin } from "./admin.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const SITES_FILE = process.env.SITES_FILE ?? "/config/sites.json";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const DEBUG_HEADERS = process.env.GATEWAY_DEBUG_HEADERS === "true";

// Dynamic sites (optional): hostnames like v18--site--example--com.<DYNAMIC_DOMAIN>, approved in the admin page.
const DYNAMIC_DOMAIN = process.env.DYNAMIC_DOMAIN?.trim().toLowerCase();
const DYNAMIC_FILE = process.env.DYNAMIC_FILE ?? "/data/dynamic.json";
const MAJORS = (process.env.MAJORS ?? "17,18,19").split(",").map((m) => Number(m.trim())).filter(Boolean);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const dynamicStore = DYNAMIC_DOMAIN ? new DynamicStore(DYNAMIC_FILE) : undefined;

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

// ---- sites ----------------------------------------------------------------

let sites = new Map();
let sitesMtime = 0;

function loadSites() {
  if (!existsSync(SITES_FILE)) {
    // Fine in dynamic-only setups: no fixed sites.
    sites = new Map();
    sitesMtime = 0;
    return;
  }
  const parsed = JSON.parse(readFileSync(SITES_FILE, "utf8"));
  const next = new Map();
  for (const [i, s] of (parsed.sites ?? []).entries()) {
    if (!s.host || !s.baseUrl || !Number.isInteger(s.major)) {
      throw new Error(`${SITES_FILE}: sites[${i}] needs host, baseUrl and an integer "major" (e.g. 18)`);
    }
    next.set(s.host.trim().toLowerCase(), { host: s.host.trim().toLowerCase(), baseUrl: s.baseUrl.replace(/\/+$/, ""), major: s.major });
  }
  sites = next;
  sitesMtime = statSync(SITES_FILE).mtimeMs;
}
loadSites();

function findSite(hostHeader) {
  try {
    const mtime = existsSync(SITES_FILE) ? statSync(SITES_FILE).mtimeMs : 0;
    if (mtime !== sitesMtime) loadSites();
  } catch (error) {
    console.error("[gateway] could not reload sites file, keeping previous config:", error.message);
  }
  const h = String(hostHeader ?? "").trim().toLowerCase();
  return sites.get(h) ?? sites.get(h.replace(/:\d+$/, ""));
}

/**
 * Decides what to do with a request's hostname:
 *   { site }                   serve it (fixed site from sites.json, or an approved dynamic one)
 *   { status, error }          answer with this status instead
 */
function resolveHost(hostHeader) {
  const fixed = findSite(hostHeader);
  if (fixed) return { site: fixed };
  if (!dynamicStore) return { status: 404, error: "Unknown host: no Umbraco site is configured for it" };

  const decoded = decodeHost(hostHeader, DYNAMIC_DOMAIN);
  if (!decoded.ok) {
    return decoded.reason === "not-dynamic"
      ? { status: 404, error: "Unknown host: no Umbraco site is configured for it" }
      : { status: 404, error: decoded.reason };
  }
  if (!MAJORS.includes(decoded.major)) {
    return { status: 404, error: `Umbraco ${decoded.major} is not supported here (supported: ${MAJORS.join(", ")})` };
  }
  if (dynamicStore.isApproved(decoded.baseUrl)) {
    const host = String(hostHeader).trim().toLowerCase().replace(/:\d+$/, "");
    return { site: { host, baseUrl: decoded.baseUrl, major: decoded.major, dynamic: true } };
  }
  const recorded = dynamicStore.recordPending(decoded.baseUrl, decoded.major);
  console.log(`[gateway] awaiting approval: ${decoded.baseUrl} (Umbraco ${decoded.major})${recorded ? "" : " [pending list full, not recorded]"}`);
  return {
    status: 403,
    error: `${decoded.baseUrl} is awaiting approval. Ask the administrator to approve it, then try again.`,
    setup: {
      note: "The Umbraco site also needs Umbraco.Mcp.HostedAuth and this block in appsettings.json (then a restart).",
      appsettings: JSON.parse(appsettingsSnippet(decoded.baseUrl, [decoded.major], DYNAMIC_DOMAIN)),
    },
  };
}

function backendFor(major) {
  return process.env[`BACKEND_V${major}`] ?? `http://mcp-v${major}:8787`;
}

// ---- proxy ----------------------------------------------------------------

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function proxy(req, res, site, major) {
  const publicHost = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host;
  const proto = (TRUST_PROXY && req.headers["x-forwarded-proto"]) || "http";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  // These headers are ours alone: never let a client supply them.
  for (const key of [...headers.keys()]) if (key.startsWith("x-mcp-")) headers.delete(key);
  if (site.dynamic) {
    headers.set("x-mcp-site-base-url", site.baseUrl);
    headers.set("x-mcp-site-major", String(site.major));
  }
  headers.set("x-forwarded-host", String(publicHost));
  headers.set("x-forwarded-proto", String(Array.isArray(proto) ? proto[0] : proto));

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream;
  try {
    upstream = await fetch(`${backendFor(major)}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
  } catch (error) {
    console.error(`[gateway] backend v${major} unreachable for ${site.host}:`, error.message);
    return json(res, 502, { error: `The Umbraco ${major} backend is not reachable` });
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key) || key === "content-encoding" || key === "set-cookie") return;
    res.setHeader(key, value);
  });
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (DEBUG_HEADERS) res.setHeader("x-mcp-backend", `v${major}`);

  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://gateway");

    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    // Caddy on-demand TLS "ask" check: only issue certificates for configured hosts.
    // Only answered for requests that did not come through the public proxy.
    if (url.pathname === "/tls-check" && !req.headers["x-forwarded-for"]) {
      return resolveHost(url.searchParams.get("domain")).site ? json(res, 200, { ok: true }) : json(res, 404, { ok: false });
    }

    const hostHeader = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host;
    const resolved = resolveHost(hostHeader);
    if (!resolved.site) return json(res, resolved.status, { error: resolved.error, ...(resolved.setup ? { setup: resolved.setup } : {}) });

    return await proxy(req, res, resolved.site, resolved.site.major);
  } catch (error) {
    console.error("[gateway] unhandled error:", error);
    if (!res.headersSent) json(res, 500, { error: "Internal Server Error" });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP gateway listening on :${PORT} with ${sites.size} site(s) from ${SITES_FILE}` + (dynamicStore ? `, dynamic sites under *.${DYNAMIC_DOMAIN}` : ""));
});

if (dynamicStore) {
  if (ADMIN_TOKEN) {
    startAdmin({ port: ADMIN_PORT, token: ADMIN_TOKEN, store: dynamicStore, staticSites: [...sites.values()], domain: DYNAMIC_DOMAIN, majors: MAJORS });
  } else {
    console.warn("[gateway] DYNAMIC_DOMAIN is set but ADMIN_TOKEN is not: nothing can be approved, so no dynamic site will be served");
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

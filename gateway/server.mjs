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
import { readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT ?? 8787);
const SITES_FILE = process.env.SITES_FILE ?? "/config/sites.json";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const DEBUG_HEADERS = process.env.GATEWAY_DEBUG_HEADERS === "true";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
  "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

// ---- sites ----------------------------------------------------------------

let sites = new Map();
let sitesMtime = 0;

function loadSites() {
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
    if (statSync(SITES_FILE).mtimeMs !== sitesMtime) loadSites();
  } catch (error) {
    console.error("[gateway] could not reload sites file, keeping previous config:", error.message);
  }
  const h = String(hostHeader ?? "").trim().toLowerCase();
  return sites.get(h) ?? sites.get(h.replace(/:\d+$/, ""));
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
      return findSite(url.searchParams.get("domain")) ? json(res, 200, { ok: true }) : json(res, 404, { ok: false });
    }

    const hostHeader = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host;
    const site = findSite(hostHeader);
    if (!site) return json(res, 404, { error: "Unknown host: no Umbraco site is configured for it" });

    return await proxy(req, res, site, site.major);
  } catch (error) {
    console.error("[gateway] unhandled error:", error);
    if (!res.headersSent) json(res, 500, { error: "Internal Server Error" });
    else res.end();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP gateway listening on :${PORT} with ${sites.size} site(s) from ${SITES_FILE}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));

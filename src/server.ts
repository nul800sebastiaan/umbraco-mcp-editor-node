/**
 * Node entry point: runs the Umbraco Editor MCP "hosted" server without Cloudflare.
 *
 * Mirrors editor/src/worker.ts, with these substitutions:
 *   Durable Object (McpAgent)        -> a fresh McpServer per HTTP request (stateless Streamable HTTP)
 *   KV namespace (OAUTH_KV)          -> SqliteKV (node:sqlite)
 *   Worker runtime / wrangler        -> node:http
 *   Cloudflare tracing               -> omitted
 *   Umbraco Cloud multi-tenant route -> omitted (single Umbraco site per server)
 *
 * The OAuth server itself is Cloudflare's own @cloudflare/workers-oauth-provider, which only
 * needs Web Crypto + a KV interface, so it runs unchanged in Node.
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import {
  createDefaultHandler,
  createSiteRoutingApiHandler,
  createWorkerExport,
  getServerOptions,
  type HostedMcpEnv,
  type HostedMcpServerOptions,
  type ChainedServerConsentConfig,
} from "@umbraco-cms/mcp-hosted";

import { collections, allModes, allModeNames, allSliceNames } from "../editor/src/collections.js";
import { SERVER_INSTRUCTIONS } from "../editor/src/server-instructions.js";
import { UMBRACO_TARGET_MAJOR } from "../editor/src/config/version-guard.js";
import {
  getLoadedCmsCollections,
  loadCmsCollections,
  needsCmsCollections,
} from "../editor/src/umbraco-api/cms-collections-loader.js";
import editorPackage from "../editor/package.json" with { type: "json" };

import { SqliteKV } from "./kv.js";
import { SiteRegistry } from "./sites.js";
import { createMcpHandler } from "./mcp-handler.js";

// ---------------------------------------------------------------------------
// Configuration (environment variables take the place of Worker secrets/vars)
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ?? "./data";

const SITES_FILE = process.env.SITES_FILE;
const OWN_MAJOR = Number(UMBRACO_TARGET_MAJOR);

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => typeof v === "string"),
) as Record<string, string>;

type Env = HostedMcpEnv & { UMBRACO_DRY_RUN?: string };

// Single-site mode: one Umbraco site from UMBRACO_BASE_URL / UMBRACO_OAUTH_CLIENT_ID.
// Multi-site mode (SITES_FILE): the site is chosen per request from the public hostname.
const registry = SITES_FILE ? new SiteRegistry(SITES_FILE, DATA_DIR) : undefined;
const singleSiteEnv = registry
  ? undefined
  : ({
      ...baseEnv,
      UMBRACO_BASE_URL: requireEnv("UMBRACO_BASE_URL"),
      UMBRACO_OAUTH_CLIENT_ID: requireEnv("UMBRACO_OAUTH_CLIENT_ID"),
      OAUTH_KV: new SqliteKV(`${DATA_DIR}/oauth-kv.sqlite`),
    } as unknown as Env);

// ---------------------------------------------------------------------------
// Server options (same as editor/src/worker.ts, single-site)
// ---------------------------------------------------------------------------

const cmsChainedServer: ChainedServerConsentConfig = {
  name: "cms",
  displayName: "umbraco-cms-mcp",
  get modeRegistry() {
    return getLoadedCmsCollections().allModes;
  },
  get collections() {
    return getLoadedCmsCollections().collections;
  },
  get allModeNames() {
    return getLoadedCmsCollections().allModeNames;
  },
  get allSliceNames() {
    return getLoadedCmsCollections().allSliceNames;
  },
};

const options: HostedMcpServerOptions = {
  name: "umbraco-cms-editor-mcp-hosted",
  version: editorPackage.version,
  expectedUmbracoMajor: UMBRACO_TARGET_MAJOR,
  instructions: SERVER_INSTRUCTIONS,
  collections,
  modeRegistry: allModes,
  allModeNames,
  allSliceNames,
  enableConsentToolSelection: false,
  authOptions: { showReauthButton: true },
  chainedServers: [cmsChainedServer],
};

const serverOptions = getServerOptions(options);

// ---------------------------------------------------------------------------
// OAuth provider + MCP handler
// ---------------------------------------------------------------------------

const provider = new OAuthProvider({
  apiRoute: ["/mcp"],
  apiHandler: createSiteRoutingApiHandler(createMcpHandler(serverOptions)),
  defaultHandler: createDefaultHandler(options) as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowPlainPKCE: false,
  clientRegistrationTTL: undefined,
});

const workerExport = createWorkerExport(provider as any, options);

const executionContext = () => ({
  waitUntil(promise: Promise<unknown>) {
    promise.catch((error) => console.error("[waitUntil] rejected:", error));
  },
  passThroughOnException() {},
  props: undefined as unknown,
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds the per-request env: the site's own Umbraco URL, client id and OAuth store. */
function envFor(request: Request): Env | Response {
  if (singleSiteEnv) return singleSiteEnv;
  const site = registry!.resolve(new URL(request.url).host);
  if (!site) return jsonError(404, "Unknown host: no Umbraco site is configured for it");
  if (site.major !== OWN_MAJOR) {
    return jsonError(421, `This backend serves Umbraco ${OWN_MAJOR}; site ${site.host} is configured as ${site.major}`);
  }
  return {
    ...baseEnv,
    UMBRACO_BASE_URL: site.baseUrl,
    ...(site.serverUrl ? { UMBRACO_SERVER_URL: site.serverUrl } : {}),
    UMBRACO_OAUTH_CLIENT_ID: site.clientId,
    OAUTH_KV: registry!.kvFor(site),
  } as unknown as Env;
}

async function handle(request: Request): Promise<Response> {
  const requestEnv = envFor(request);
  if (requestEnv instanceof Response) return requestEnv;

  const consentToolSelection =
    options.enableConsentToolSelection ?? requestEnv.ENABLE_CONSENT_TOOL_SELECTION === "true";
  if (needsCmsCollections(new URL(request.url).pathname, consentToolSelection)) {
    try {
      await loadCmsCollections();
    } catch (error) {
      console.error("[server] Failed to load @umbraco-cms/mcp-dev collections:", error);
    }
  }
  return workerExport.fetch(request, requestEnv, executionContext() as any);
}

// ---------------------------------------------------------------------------
// node:http <-> Fetch API bridge
// ---------------------------------------------------------------------------

function toRequest(req: IncomingMessage): Request {
  // Behind a TLS-terminating proxy (Caddy/nginx), trust X-Forwarded-* from it only.
  const proto = (process.env.TRUST_PROXY === "true" && req.headers["x-forwarded-proto"]) || "http";
  const host =
    (process.env.TRUST_PROXY === "true" && (req.headers["x-forwarded-host"] as string)) ||
    req.headers.host ||
    `localhost:${PORT}`;
  const url = `${Array.isArray(proto) ? proto[0] : proto}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  // The hosted package upgrades http->https from this header when present.
  if (process.env.TRUST_PROXY !== "true") headers.delete("x-forwarded-proto");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error Node requires duplex for streamed bodies
    duplex: hasBody ? "half" : undefined,
  });
}

async function sendResponse(response: Response, res: ServerResponse) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader("set-cookie", cookies);
  if (!response.body) return res.end();
  const reader = response.body.getReader();
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

const httpServer = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.statusCode = 200;
    return res.end("ok");
  }
  try {
    await sendResponse(await handle(toRequest(req)), res);
  } catch (error) {
    console.error("[server] unhandled error:", error);
    if (!res.headersSent) res.statusCode = 500;
    res.end("Internal Server Error");
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(
    `Umbraco Editor MCP ${OWN_MAJOR} (Node) listening on http://${HOST}:${PORT}  -> ` +
      (singleSiteEnv ? `Umbraco: ${singleSiteEnv.UMBRACO_BASE_URL}` : `sites from ${SITES_FILE}`),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpServer.close(() => {
      (singleSiteEnv?.OAUTH_KV as unknown as SqliteKV | undefined)?.close();
      registry?.close();
      process.exit(0);
    });
  });
}

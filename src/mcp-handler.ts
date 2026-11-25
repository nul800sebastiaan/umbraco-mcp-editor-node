/**
 * Replaces the Cloudflare `McpAgent` Durable Object.
 *
 * Each authenticated request gets its own McpServer (created by mcp-hosted's
 * createPerRequestServer, which binds the caller's Umbraco token via AsyncLocalStorage)
 * and its own stateless Streamable HTTP transport. Nothing is shared between users.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPerRequestServer, type AuthProps, type HostedMcpEnv } from "@umbraco-cms/mcp-hosted";
import { applyWorkerDryRun } from "../editor/src/config/worker-dry-run.js";
import { registerCmsChainedServer } from "../editor/src/umbraco-api/cms-chained-server.js";

type ServerOptions = Parameters<typeof createPerRequestServer>[0];

let cmsRegistered: Promise<void> | undefined;

export function createMcpHandler(serverOptions: ServerOptions) {
  return {
    async fetch(request: Request, env: HostedMcpEnv, ctx: { props?: unknown }): Promise<Response> {
      const props = ctx.props as AuthProps | undefined;
      if (!props) {
        return new Response("Unauthorized", { status: 401 });
      }

      const server = await createPerRequestServer(serverOptions, env, props, undefined);
      applyWorkerDryRun(env as { UMBRACO_DRY_RUN?: string });
      // In-process "cms" server used by the editor tools; registered once per process.
      cmsRegistered ??= registerCmsChainedServer().catch((error) => {
        cmsRegistered = undefined;
        throw error;
      });
      await cmsRegistered;

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        // Release the per-request server once the response has been produced.
        queueMicrotask(() => void server.close().catch(() => {}));
      }
    },
  };
}

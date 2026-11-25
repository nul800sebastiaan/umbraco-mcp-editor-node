import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";

const cfShim = fileURLToPath(new URL("./src/shims/cloudflare-workers.ts", import.meta.url));

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Cloudflare's OAuth library is bundled so its `cloudflare:workers` import can be aliased
  // to our shim. Everything else resolves from node_modules at runtime.
  noExternal: ["@cloudflare/workers-oauth-provider"],
  esbuildOptions(options) {
    options.alias = { ...options.alias, "cloudflare:workers": cfShim };
  },
});

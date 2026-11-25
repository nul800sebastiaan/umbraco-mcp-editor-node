# umbraco-mcp-editor-node

Self-host the **Umbraco Editor MCP** (hosted/OAuth flavour) in Docker, without Cloudflare. Supports Umbraco **17, 18 and 19** side by side. Unofficial: Umbraco documents only a Cloudflare Worker, and this is a Node runtime for the same upstream code.

```
Claude ──https──> Caddy ──> gateway ──┬─> mcp-v17
 marketing.mcp.example.com            ├─> mcp-v18
 intranet.mcp.example.com             └─> mcp-v19 (beta)
```

One hostname per Umbraco site. The gateway looks the host up in `sites.json` and forwards to the backend for that site's Umbraco major. Each backend runs the upstream Editor MCP for that major, with OAuth state in SQLite (one file per site) instead of Cloudflare KV, and a fresh stateless MCP server per request instead of a Durable Object.

## 1. Configure each Umbraco site

Install the `Umbraco.Mcp.HostedAuth` NuGet package matching the site's major, then add to `appsettings.json`:

```json
"HostedMcp": {
  "Clients": [
    {
      "ClientId": "umbraco-cms-editor-mcp-hosted",
      "Origins": [ "https://marketing.mcp.example.com" ]
    }
  ]
}
```

`Origins` is the public URL of this site's MCP hostname. HostedAuth registers `{origin}/callback` and `{origin}/logout-callback` on startup, so restart the site after changing it.

## 2. Run it

```bash
cp sites.example.json sites.json   # one entry per Umbraco site
docker compose up -d               # pulls prebuilt images from ghcr.io
```

Images are built by GitHub Actions on every push to `main`: `ghcr.io/nul800sebastiaan/umbraco-mcp-editor-node:v17|v18|v19` and `…-gateway:latest` (plus per-commit `sha` tags). To build locally instead, use `docker compose up -d --build`.

`sites.json` entries (all required):

| Field | Meaning |
|---|---|
| `host` | MCP hostname, e.g. `marketing.mcp.example.com` |
| `baseUrl` | The Umbraco site, e.g. `https://marketing.example.com` |
| `clientId` | Same as `ClientId` above |
| `major` | `17`, `18` or `19`. Umbraco doesn't expose its version without a login, so it must be stated. |

Point DNS for the hostnames (a wildcard works) at the VM. Caddy gets certificates on demand, only for hosts in `sites.json`. Edits to `sites.json` are picked up without a restart. Not running some major? Delete that service and its volume from `docker-compose.yml`.

Optional `.env` (see `.env.example`): `UMBRACO_TOOL_MODES`, `UMBRACO_READONLY`, `UMBRACO_DRY_RUN`.

### Dockhand / Portainer

Create a stack and paste `docker-compose.stack.yml`. It needs no uploaded files: `sites.json` and the Caddyfile are inlined as `configs`, so edit the site list in the stack editor and redeploy. Open ports 80/443 and point DNS at the VPS.

### Behind Pangolin

Use `docker-compose.pangolin.yml` instead (no Caddy). Set its `pangolin` network to the one your Newt connector is on, then in Pangolin create a public resource (subdomain `*` for a wildcard, or one per site) targeting `http://umbraco-mcp-gateway:8787` with Pangolin authentication off. Keep `TRUST_PROXY=true` so the gateway picks the site from `X-Forwarded-Host`.

## 3. Connect Claude

Add a custom connector with `https://marketing.mcp.example.com/mcp` and sign in with a backoffice account. Claude Code:

```bash
claude mcp add --transport http umbraco-marketing https://marketing.mcp.example.com/mcp
```

Tools run with that user's own Umbraco permissions.

## Versions

Upstream refs are build args in `docker-compose.yml` (`EDITOR_MCP_REF`: `v17.6.2`, `v18.0.2`, `v19.0.0-beta.2`). `locks/` holds one lockfile per major. Re-run `scripts/sync-editor.sh` with a different ref to bump.

## Local testing

Claude Code only allows plain-HTTP OAuth endpoints on `localhost`, so use `Origins: ["http://localhost:8787"]`, a single site with `host: "localhost"`, and run the containers with `--network host`. For a dev site with a self-signed certificate, set `NODE_EXTRA_CA_CERTS` to its public certificate rather than disabling TLS checks.

## Security

- `/data` holds OAuth grants and encrypted Umbraco tokens. Keep the volumes private.
- Backends trust `X-Forwarded-*`, so only the gateway should reach them (compose publishes no backend ports).
- `/register` is open, as on the Worker. Rate-limit it if internet-facing.
- Leave `ENABLE_INFO_ENDPOINT` unset in production.

## Status

Tested: image builds, per-host routing across majors, per-site OAuth isolation, and a full login plus real tool calls (read and edit) against Umbraco 18.3.2 with HostedAuth 18.

Not tested: Umbraco 17 and 19 against live sites (19 is beta), two simultaneous users, and server-initiated messages (stateless mode has none). `/info` returns 500 (looks like an upstream bug in `mcp-dev`; diagnostic only).

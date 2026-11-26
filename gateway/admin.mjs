/**
 * Tiny approval page. Served on its own port (never the public MCP port) and only when
 * ADMIN_TOKEN is set. Put it behind its own authenticated route (e.g. a Pangolin resource with
 * authentication on); the token is a second lock for anything else that can reach the port.
 */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { appsettingsSnippet, assertPublicHost } from "./dynamic.mjs";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sha = (s) => createHash("sha256").update(s).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const CSS = `
:root{--bg:#fff;--fg:#1b1b1f;--muted:#6b6b76;--line:#e3e3e8;--card:#f7f7f9;--accent:#3544b1;--ok:#1a7f4b;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#131316;--fg:#ececf1;--muted:#9a9aa6;--line:#2c2c33;--card:#1b1b20;--accent:#8c9bff;--ok:#5bd69a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:1.3rem;margin:0 0 4px}h2{font-size:1rem;margin:28px 0 8px}
p.sub{color:var(--muted);margin:0 0 16px}.row{display:flex;gap:12px;align-items:center;justify-content:space-between;
background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0;flex-wrap:wrap}
.row b{word-break:break-all}.meta{color:var(--muted);font-size:13px}form{display:inline;margin:0}
button{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:5px 12px;cursor:pointer}
button.ok{border-color:var(--ok);color:var(--ok)}button.bad{border-color:var(--bad);color:var(--bad)}
input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);width:100%;max-width:340px}
.msg{padding:8px 12px;border-radius:8px;background:var(--card);border:1px solid var(--line);margin-bottom:12px}.empty{color:var(--muted)}details{width:100%}summary{cursor:pointer;color:var(--accent);font-size:13px}
pre{margin:6px 0 0;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:auto;font-size:12px;user-select:all}
code{background:var(--card);padding:1px 5px;border-radius:4px}`;

const page = (body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>MCP site approvals</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

export function startAdmin({ port, token, store, staticSites, domain, majors }) {
  const cookieValue = sha(`mcp-admin:${token}`);

  const authed = (req) => {
    const cookie = /(?:^|;\s*)mcp_admin=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    return Boolean(cookie) && safeEqual(cookie, cookieValue);
  };

  const readForm = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 4096) {
          reject(new Error("too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(new URLSearchParams(data)));
      req.on("error", reject);
    });

  const send = (res, status, html, headers = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", ...headers });
    res.end(html);
  };
  const redirect = (res, to) => {
    res.writeHead(303, { location: to });
    res.end();
  };

  const loginPage = (message) =>
    page(`<h1>MCP site approvals</h1><p class="sub">Enter the admin token.</p>${message ? `<div class="msg">${esc(message)}</div>` : ""}
<form method="post" action="/login"><input type="password" name="token" autocomplete="current-password" autofocus> <button class="ok">Sign in</button></form>`);

  const dashboard = (message) => {
    const snippet = (url, majors) =>
      `<details><summary>appsettings.json for this site</summary><pre>${esc(appsettingsSnippet(url, majors, domain))}</pre></details>`;
    const pending = [...store.pending.entries()]
      .map(([url, p]) => `<div class="row"><div><b>${esc(url)}</b><div class="meta">Umbraco ${p.majors.map(esc).join(", ")} &middot; first seen ${esc(p.firstSeen)}</div></div>
<div><form method="post" action="/approve"><input type="hidden" name="site" value="${esc(url)}"><button class="ok">Approve</button></form>
<form method="post" action="/deny"><input type="hidden" name="site" value="${esc(url)}"><button class="bad">Deny</button></form></div>${snippet(url, p.majors)}</div>`)
      .join("");
    const approved = [...store.approved.entries()]
      .map(([url, a]) => `<div class="row"><div><b>${esc(url)}</b><div class="meta">approved ${esc(a.approvedAt)}</div></div>
<form method="post" action="/remove"><input type="hidden" name="site" value="${esc(url)}"><button class="bad">Remove</button></form>${snippet(url, majors)}</div>`)
      .join("");
    const fixed = staticSites.map((s) => `<div class="row"><div><b>${esc(s.baseUrl)}</b><div class="meta">${esc(s.host)} &middot; Umbraco ${esc(s.major)} &middot; from sites.json</div></div></div>`).join("");
    return page(`<h1>MCP site approvals</h1><p class="sub">Sites connect with hostnames like <code>v18--site--example--com.${esc(domain)}</code> (supported majors: ${esc(majors.join(", "))}). Approving a site allows every version of it.</p>
${message ? `<div class="msg">${esc(message)}</div>` : ""}
<h2>Waiting for approval</h2>${pending || '<p class="empty">Nothing waiting.</p>'}
<h2>Approved</h2>${approved || '<p class="empty">No approved sites yet.</p>'}
${fixed ? `<h2>Fixed in sites.json</h2>${fixed}` : ""}`);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://admin");
      const secure = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] === "https";

      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"ok":true}');
      }

      if (req.method === "POST") {
        // CSRF: cookie is SameSite=Strict; also require a same-origin Origin header when present.
        const origin = req.headers.origin;
        const host = req.headers["x-forwarded-host"] ?? req.headers.host;
        if (origin && new URL(origin).host !== host) return send(res, 403, page("<p>Cross-origin request refused.</p>"));

        if (url.pathname === "/login") {
          const form = await readForm(req);
          if (!safeEqual(sha(form.get("token") ?? ""), sha(token))) return send(res, 401, loginPage("Wrong token."));
          res.setHeader("set-cookie", `mcp_admin=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`);
          return redirect(res, "/");
        }

        if (!authed(req)) return send(res, 401, loginPage());
        const form = await readForm(req);
        const site = form.get("site") ?? "";
        let msg = "";
        if (url.pathname === "/approve") {
          try {
            await assertPublicHost(new URL(site).hostname);
            store.approve(site);
            msg = `Approved ${site}`;
          } catch (error) {
            msg = `Not approved: ${error.message}`;
          }
        } else if (url.pathname === "/deny") {
          store.deny(site);
          msg = `Denied ${site}`;
        } else if (url.pathname === "/remove") {
          store.remove(site);
          msg = `Removed ${site}`;
        } else {
          return send(res, 404, page("<p>Not found.</p>"));
        }
        return redirect(res, `/?m=${encodeURIComponent(msg)}`);
      }

      if (!authed(req)) return send(res, 401, loginPage());
      return send(res, 200, dashboard(url.searchParams.get("m") ?? ""));
    } catch (error) {
      console.error("[admin] error:", error.message);
      if (!res.headersSent) send(res, 500, page("<p>Something went wrong.</p>"));
      else res.end();
    }
  });

  server.listen(port, "0.0.0.0", () => console.log(`[admin] approval page on :${port}`));
  return server;
}

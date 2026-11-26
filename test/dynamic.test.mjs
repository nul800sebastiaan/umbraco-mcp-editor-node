import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { decodeHost, isPublicAddress, DynamicStore } from "../gateway/dynamic.mjs";

const D = "mcp.example.com";

test("decodes version and site from the hostname", () => {
  assert.deepEqual(decodeHost("v18--releases--umbraco--com.mcp.example.com", D), {
    ok: true, major: 18, baseUrl: "https://releases.umbraco.com", name: "releases.umbraco.com",
  });
  assert.equal(decodeHost("v17--my-site--example--co--uk.mcp.example.com:8443", D).baseUrl, "https://my-site.example.co.uk");
});

test("rejects bad or non-public names", () => {
  for (const h of [
    "releases--umbraco--com.mcp.example.com", // no version
    "v18--localhost.mcp.example.com",         // one label
    "v18--foo--local.mcp.example.com",        // blocked suffix
    "v18--192--168--1--1.mcp.example.com",    // numeric tld
    "v18---x--com.mcp.example.com",           // triple hyphen
    "v18--a--b--com.sub.mcp.example.com",     // extra label
  ]) assert.equal(decodeHost(h, D).ok, false, h);
  assert.equal(decodeHost("other.example.org", D).reason, "not-dynamic");
});

test("address filter", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("store: pending, approve, version change needs no new approval", () => {
  const f = join(mkdtempSync(join(tmpdir(), "dyn-")), "d.json");
  const s = new DynamicStore(f, { maxPending: 2 });
  assert.equal(s.recordPending("https://a.example", 18), true);
  assert.equal(s.recordPending("https://b.example", 18), true);
  assert.equal(s.recordPending("https://c.example", 18), false); // cap
  s.approve("https://a.example");
  const again = new DynamicStore(f);
  assert.equal(again.isApproved("https://a.example"), true);
  assert.equal(again.isApproved("https://b.example"), false);
  assert.throws(() => again.approve("https://zzz.example"));
});

test("gateway: pending -> approved -> proxied with site headers; client headers stripped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const dyn = join(dir, "dynamic.json");
  writeFileSync(dyn, JSON.stringify({ approved: { "https://ok.example.com": { approvedAt: "x" } } }));
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push(req.headers);
    res.end("hi");
  });
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const gw = spawn("node", ["gateway/server.mjs"], {
    env: { ...process.env, PORT: String(port), SITES_FILE: join(dir, "none.json"), DYNAMIC_DOMAIN: D, DYNAMIC_FILE: dyn,
      ADMIN_TOKEN: "t", ADMIN_PORT: String(port + 1), TRUST_PROXY: "true", BACKEND_V18: `http://127.0.0.1:${backend.address().port}` },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const call = (host, headers = {}) => fetch(`http://127.0.0.1:${port}/x`, { headers: { "x-forwarded-host": host, ...headers } });

    assert.equal((await call("v18--new--example--com.mcp.example.com")).status, 403);       // pending
    assert.equal((await call("v18--ok--example--com.mcp.example.com", { "x-mcp-site-base-url": "https://evil" })).status, 200);
    assert.equal(seen[0]["x-mcp-site-base-url"], "https://ok.example.com");                 // ours, not the client's
    assert.equal(seen[0]["x-mcp-site-major"], "18");
    assert.equal((await call("v19--ok--example--com.mcp.example.com")).status, 502);        // approved site, newer major: no new approval; backend v19 just is not running here
  } finally {
    gw.kill();
    backend.close();
  }
});

import { encodeHost, appsettingsSnippet } from "../gateway/dynamic.mjs";

test("encodeHost is the inverse of decodeHost", () => {
  for (const [url, major] of [["https://releases.umbraco.com", 18], ["https://my-site.example.co.uk", 17]]) {
    const host = encodeHost(url, major, D);
    const back = decodeHost(host, D);
    assert.equal(back.ok, true, host);
    assert.equal(back.baseUrl, url);
    assert.equal(back.major, major);
  }
});

test("appsettings snippet lists one origin per major", () => {
  const s = JSON.parse(appsettingsSnippet("https://releases.umbraco.com", [19, 18], D));
  assert.deepEqual(s.HostedMcp.Clients[0], {
    ClientId: "umbraco-cms-editor-mcp-hosted",
    Origins: ["https://v18--releases--umbraco--com.mcp.example.com", "https://v19--releases--umbraco--com.mcp.example.com"],
  });
});

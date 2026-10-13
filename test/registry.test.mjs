import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveDigest } from "../lib/registry.mjs";

const DIGEST = "sha256:" + "c".repeat(64);
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

// A registry that wants a Bearer token (GHCR / Docker Hub style): manifests -> 401 + challenge; token endpoint needs Basic creds for private repos.
function bearerRegistry({ user, pass }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    const port = server.address().port;
    if (req.url.startsWith("/token")) {
      if (req.headers.authorization !== basic(user, pass)) { res.statusCode = 401; return res.end(); }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ token: "tok123" }));
    }
    if (req.url.startsWith("/v2/team/app/manifests/")) {
      if (req.headers.authorization === "Bearer tok123") { res.setHeader("docker-content-digest", DIGEST); return res.end(); }
      res.statusCode = 401;
      res.setHeader("www-authenticate", `Bearer realm="http://127.0.0.1:${port}/token",service="reg",scope="repository:team/app:pull"`);
      return res.end();
    }
    res.statusCode = 404; res.end();
  });
  return new Promise((r) => server.listen(0, () => r({ host: `127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

// A registry with plain Basic auth (what `registry:2` + htpasswd does).
function basicRegistry({ user, pass }) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== basic(user, pass)) { res.statusCode = 401; res.setHeader("www-authenticate", 'Basic realm="r"'); return res.end(); }
    res.setHeader("docker-content-digest", DIGEST); res.end();
  });
  return new Promise((r) => server.listen(0, () => r({ host: `127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test("bearer-token registry: resolves with credentials", async () => {
  const reg = await bearerRegistry({ user: "u", pass: "p" });
  try {
    const d = await resolveDigest(`${reg.host}/team/app:latest`, { auths: { [reg.host]: { username: "u", password: "p" } } });
    assert.equal(d, DIGEST);
  } finally { reg.close(); }
});

test("bearer-token registry: wrong or missing credentials fail (no silent pass)", async () => {
  const reg = await bearerRegistry({ user: "u", pass: "p" });
  try {
    await assert.rejects(() => resolveDigest(`${reg.host}/team/app:latest`, { auths: { [reg.host]: { username: "u", password: "WRONG" } } }), /token request failed: HTTP 401/);
    await assert.rejects(() => resolveDigest(`${reg.host}/team/app:latest`, { auths: {} }), /token request failed: HTTP 401/);
  } finally { reg.close(); }
});

test("basic-auth registry: credentials accepted, absence rejected", async () => {
  const reg = await basicRegistry({ user: "u", pass: "p" });
  try {
    assert.equal(await resolveDigest(`${reg.host}/x/y:1`, { auths: { [reg.host]: { username: "u", password: "p" } } }), DIGEST);
    await assert.rejects(() => resolveDigest(`${reg.host}/x/y:1`, { auths: {} }), /HTTP 401/);
    await assert.rejects(() => resolveDigest(`${reg.host}/x/y:1`, { auths: { [reg.host]: { username: "u", password: "bad" } } }), /HTTP 401/);
  } finally { reg.close(); }
});

test("a pinned digest never touches the network", async () => {
  assert.equal(await resolveDigest(`example.invalid/a/b@${DIGEST}`), DIGEST);
});

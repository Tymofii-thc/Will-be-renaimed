import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { findRecord, parseMemo, repoName, resolveRpc } from "../lib/oath.mjs";

const D1 = "sha256:" + "a".repeat(64);
const D2 = "sha256:" + "b".repeat(64);
const memo = (image, digest) => `[${100}] pod1|${image}|0123456789ab|${digest}|2026-01-01T00:00:00.000Z`;

// Mock Solana RPC: txs[signer] = newest-first list of { signature, memo, err, blockTime }
function mockRpc(txs) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params, id } = JSON.parse(body);
      calls.push(params);
      const [addr, opts] = params;
      let list = txs[addr] || [];
      if (opts.before) list = list.slice(list.findIndex((t) => t.signature === opts.before) + 1);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: list.slice(0, opts.limit) }));
    });
  });
  return new Promise((r) => server.listen(0, () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}
const tx = (n, m, extra = {}) => ({ signature: `sig${n}`, memo: m, err: null, blockTime: Math.floor(Date.now() / 1000) - n, ...extra });

test("repoName normalizes refs", () => {
  assert.equal(repoName("ghcr.io/Me/App:latest"), "ghcr.io/me/app");
  assert.equal(repoName(`ghcr.io/me/app@${D1}`), "ghcr.io/me/app");
  assert.equal(repoName("alpine:3.20"), "docker.io/library/alpine");
  assert.equal(repoName("me/app"), "docker.io/me/app");
  assert.equal(repoName("localhost:5055/demo/app:latest"), "localhost:5055/demo/app");
});

test("parseMemo handles joined memos and ignores foreign ones", () => {
  const r = parseMemo(`[5] hello; ${memo("x/y", D1)}`);
  assert.equal(r.length, 1);
  assert.equal(r[0].digest, D1);
});

test("resolveRpc precedence and unknown network", () => {
  assert.equal(resolveRpc({ rpc: "http://x", env: {} }), "http://x");
  assert.equal(resolveRpc({ env: { SOLANA_RPC: "http://y" } }), "http://y");
  assert.match(resolveRpc({ network: "mainnet", env: {} }), /mainnet-beta/);
  assert.match(resolveRpc({ env: {} }), /devnet/);
  assert.throws(() => resolveRpc({ network: "nope", env: {} }));
});

test("match, mismatch, failed tx ignored", async () => {
  const m = await mockRpc({ S: [tx(1, memo("ghcr.io/me/app", D1), { err: { x: 1 } }), tx(2, memo("ghcr.io/me/app", D2))] });
  try {
    assert.equal(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url }), null, "failed tx must not count");
    const hit = await findRecord({ signers: ["S"], digest: D2, rpcUrl: m.url });
    assert.equal(hit.signature, "sig2");
    assert.equal(await findRecord({ signers: ["other"], digest: D2, rpcUrl: m.url }), null, "other signer");
  } finally { m.close(); }
});

test("image binding: same digest anchored for a different image is rejected", async () => {
  const m = await mockRpc({ S: [tx(1, memo("ghcr.io/me/other", D1))] });
  try {
    assert.equal(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, image: "ghcr.io/me/app" }), null);
    assert.ok(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, image: "ghcr.io/me/other:latest" }));
    assert.ok(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url }), "no binding when image is omitted");
  } finally { m.close(); }
});

test("key rotation: any of several signers is accepted", async () => {
  const m = await mockRpc({ OLD: [tx(1, memo("a/b", D1))], NEW: [] });
  try {
    assert.ok(await findRecord({ signers: ["NEW", "OLD"], digest: D1, rpcUrl: m.url }));
    assert.equal(await findRecord({ signers: ["NEW"], digest: D1, rpcUrl: m.url }), null, "revoked key no longer listed");
  } finally { m.close(); }
});

test("max age", async () => {
  const m = await mockRpc({ S: [tx(10 * 86400, memo("a/b", D1))] });
  try {
    assert.equal(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, maxAgeSeconds: 5 * 86400 }), null);
    assert.ok(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, maxAgeSeconds: 30 * 86400 }));
  } finally { m.close(); }
});

test("pagination: record older than one page is still found", async () => {
  const noise = Array.from({ length: 2500 }, (_, i) => tx(i + 1, memo("a/b", D2)));
  noise.push(tx(2600, memo("a/b", D1)));
  const m = await mockRpc({ S: noise });
  try {
    const hit = await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, limit: 5000 });
    assert.equal(hit.signature, "sig2600");
    assert.ok(m.calls.length >= 3);
    assert.equal(await findRecord({ signers: ["S"], digest: D1, rpcUrl: m.url, limit: 1000 }), null, "limit respected");
  } finally { m.close(); }
});

test("RPC failure throws (caller must treat as deny, not as verified)", async () => {
  await assert.rejects(() => findRecord({ signers: ["S"], digest: D1, rpcUrl: "http://127.0.0.1:1" }));
});

test("quorum: needs N distinct signers; one signer repeating does not count twice", async () => {
  const m = await mockRpc({ A: [tx(1, memo("a/b", D1)), tx(2, memo("a/b", D1))], B: [tx(3, memo("a/b", D1))], C: [] });
  try {
    assert.equal(await findRecord({ signers: ["A", "C"], digest: D1, rpcUrl: m.url, quorum: 2 }), null, "A alone twice is still one signer");
    const ok = await findRecord({ signers: ["A", "B", "C"], digest: D1, rpcUrl: m.url, quorum: 2 });
    assert.deepEqual([...ok.signers].sort(), ["A", "B"]);
    assert.equal(await findRecord({ signers: ["A"], digest: D1, rpcUrl: m.url, quorum: 2 }), null, "quorum above signer count can never pass");
    assert.ok(await findRecord({ signers: ["A", "A"], digest: D1, rpcUrl: m.url, quorum: 1 }));
  } finally { m.close(); }
});

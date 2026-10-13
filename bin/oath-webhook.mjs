#!/usr/bin/env node
// oath admission webhook: blocks Pods whose images were not anchored on Solana by the trusted CI signer(s),
// and pins tags to the verified digest so what was checked is exactly what the kubelet pulls.
//
// Env: OATH_SIGNER (comma separated, required)   OATH_NETWORK | SOLANA_RPC   OATH_MAX_AGE_DAYS
//      OATH_QUORUM=<N> (distinct signers required)   OATH_ATTEST_REPO=<owner/repo> (also require a Sigstore build attestation)
//      OATH_MODE=enforce|audit (default enforce)  OATH_PIN=true|false (default true)
//      OATH_REGISTRY_AUTH='{"ghcr.io":{"username":"u","password":"token"}}' (private registries)
//      TLS_CERT, TLS_KEY (default /tls/tls.crt, /tls/tls.key)   PORT (default 8443)   OATH_PLAIN_HTTP=1 (tests only)
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { resolveRpc } from "../lib/oath.mjs";
import { makeHandler } from "../lib/admission.mjs";

const signers = (process.env.OATH_SIGNER || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!signers.length) { console.error("OATH_SIGNER is required"); process.exit(2); }

const handler = makeHandler({
  signers,
  rpcUrl: resolveRpc({}),
  maxAgeSeconds: process.env.OATH_MAX_AGE_DAYS ? Number(process.env.OATH_MAX_AGE_DAYS) * 86400 : undefined,
  quorum: Number(process.env.OATH_QUORUM || 1),
  attestRepo: process.env.OATH_ATTEST_REPO || undefined,
  mode: process.env.OATH_MODE || "enforce",
  pin: process.env.OATH_PIN !== "false",
  auths: process.env.OATH_REGISTRY_AUTH ? JSON.parse(process.env.OATH_REGISTRY_AUTH) : {},
});

const app = async (req, res) => {
  const path = new URL(req.url, "http://x").pathname; // the API server appends ?timeout=…
  if (req.method === "GET" && (path === "/healthz" || path === "/readyz")) { res.end("ok"); return; }
  if (req.method !== "POST" || path !== "/validate") { res.statusCode = 404; res.end(); return; }
  let body = "";
  for await (const c of req) { body += c; if (body.length > 4_000_000) { res.statusCode = 413; res.end(); return; } }
  try {
    const out = await handler(JSON.parse(body));
    const r = out.response;
    console.log(JSON.stringify({ uid: r.uid, allowed: r.allowed, msg: r.status?.message, warn: r.warnings }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  } catch (e) {
    console.error("bad request:", e.message);
    res.statusCode = 400; res.end();
  }
};

const port = Number(process.env.PORT || 8443);
const server = process.env.OATH_PLAIN_HTTP
  ? http.createServer(app)
  : https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT || "/tls/tls.crt"), key: fs.readFileSync(process.env.TLS_KEY || "/tls/tls.key") }, app);
server.listen(port, () => console.log(`oath webhook on :${port} signers=${signers.join(",")} mode=${process.env.OATH_MODE || "enforce"}`));

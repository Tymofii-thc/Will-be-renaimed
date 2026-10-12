#!/usr/bin/env node
// oath — Proof of Deploy CLI
//
//   oath verify --signer <pubkey> --digest sha256:<hex>
//   oath verify --signer <pubkey> --image ghcr.io/me/app:latest      (digest read from local docker)
//   oath verify --signer <pubkey> --container prod                   (digest of the RUNNING image)
//
// Exit codes: 0 = verified, 1 = NOT verified, 2 = usage / network error.
// Put it right before your deploy step: if it exits non-zero, the deploy stops.
import { execFileSync } from "node:child_process";

const DEFAULT_RPC = "https://api.devnet.solana.com";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

function docker(args) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    fail(2, `docker failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}

export function extractDigest(s) {
  const m = (s || "").match(/sha256:[0-9a-fA-F]{64}/);
  return m ? m[0].toLowerCase() : null;
}

// RPC returns memo as "[<len>] <text>"; several memos in one tx are joined by "; ".
export function parseMemo(memo) {
  if (!memo) return [];
  return memo
    .split("; ")
    .map((m) => m.replace(/^\[\d+\]\s*/, ""))
    .filter((m) => m.startsWith("pod1|"))
    .map((m) => {
      const [, image, commit, digest, ts] = m.split("|");
      return { image, commit, digest, ts };
    });
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function resolveDigest() {
  const direct = arg("digest");
  if (direct) return extractDigest(direct);

  const container = arg("container");
  if (container) {
    const imageId = docker(["inspect", "--format", "{{.Image}}", container]);
    return extractDigest(docker(["inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", imageId]));
  }

  const image = arg("image");
  if (image) {
    return extractDigest(docker(["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", image]));
  }
  return null;
}

async function verify() {
  const signer = arg("signer") || process.env.OATH_SIGNER || process.env.POD_SIGNER;
  const rpcUrl = arg("rpc") || process.env.SOLANA_RPC || DEFAULT_RPC;
  const limit = Number(arg("limit") || 100);

  if (!signer) fail(2, "Missing --signer <public key of the CI signer> (or OATH_SIGNER).");
  const want = resolveDigest();
  if (!want) fail(2, "Could not determine a sha256 digest. Pass --digest, --image or --container.");

  let sigs;
  try {
    sigs = await rpc(rpcUrl, "getSignaturesForAddress", [signer, { limit }]);
  } catch (e) {
    fail(2, `RPC lookup failed: ${e.message}`);
  }

  for (const s of sigs) {
    if (s.err) continue;
    for (const rec of parseMemo(s.memo)) {
      if (rec.digest === want) {
        const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : rec.ts;
        console.log(`VERIFIED  ${want}`);
        console.log(`  built from commit ${rec.commit} (${rec.image})`);
        console.log(`  anchored at ${when}`);
        console.log(`  tx ${s.signature}`);
        process.exit(0);
      }
    }
  }

  console.error(`NOT VERIFIED  ${want}`);
  console.error(`  No pipeline build with this digest was anchored by ${signer}.`);
  console.error("  Refusing to proceed: the image may have been replaced outside the pipeline.");
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === "verify") {
  await verify();
} else {
  console.error("Usage: oath verify --signer <pubkey> (--digest sha256:… | --image <ref> | --container <name>) [--rpc <url>]");
  process.exit(2);
}

#!/usr/bin/env node
// oath — Proof of Deploy CLI
//
//   oath verify --signer <pubkey[,pubkey…]> --digest sha256:<hex>
//   oath verify --signer <pubkey> --image ghcr.io/me/app:latest      (digest read from local docker)
//   oath verify --signer <pubkey> --container prod                   (digest of the RUNNING image)
//   oath audit  --signer <pubkey> [--file pods.json] [--skip-namespaces a,b]   (every Pod running in the current kube context)
//
// Options: --network devnet|mainnet | --rpc <url>   --max-age <days>   --limit <txs per signer, default 1000>
//          --quorum <N>  at least N distinct signers must have anchored the digest (a stolen CI key alone is then not enough)
//          --attest <owner/repo>  also require a Sigstore-signed SLSA build attestation from that repo's GitHub Actions
//          --no-bind  (don't require the record's image name to match the image being checked)
// Env:     OATH_SIGNER (comma separated), OATH_NETWORK, SOLANA_RPC, OATH_QUORUM, OATH_ATTEST_REPO, GITHUB_TOKEN (optional, API rate limit)
//
// Exit codes: 0 = verified, 1 = NOT verified, 2 = usage / network error.
// Put it right before your deploy step: if it exits non-zero, the deploy stops.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extractDigest, findRecord, repoName, resolveRpc } from "../lib/oath.mjs";
import { collectImages } from "../lib/audit.mjs";
import { verifyAttestation } from "../lib/attest.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

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

// All "repo@sha256:…" entries of a local image; prefer the one whose repo matches `ref`.
function pickRepoDigest(lines, ref) {
  const all = lines.split("\n").map((l) => l.trim()).filter(Boolean);
  const want = repoName(ref);
  const chosen = (want && all.find((l) => repoName(l) === want)) || all[0];
  return chosen ? { digest: extractDigest(chosen), repo: repoName(chosen) } : null;
}

function resolveTarget() {
  const direct = arg("digest");
  if (direct) return { digest: extractDigest(direct), repo: null };

  const fmt = "{{range .RepoDigests}}{{println .}}{{end}}";
  const container = arg("container");
  if (container) {
    const imageId = docker(["inspect", "--format", "{{.Image}}", container]);
    return pickRepoDigest(docker(["inspect", "--format", fmt, imageId])) || { digest: null };
  }
  const image = arg("image");
  if (image) {
    return pickRepoDigest(docker(["image", "inspect", "--format", fmt, image]), image) || { digest: null };
  }
  return { digest: null };
}

async function verify() {
  const signers = (arg("signer") || process.env.OATH_SIGNER || process.env.POD_SIGNER || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!signers.length) fail(2, "Missing --signer <public key of the CI signer> (or OATH_SIGNER). Comma-separate several to accept a rotation.");

  let rpcUrl;
  try {
    rpcUrl = resolveRpc({ rpc: arg("rpc"), network: arg("network") });
  } catch (e) {
    fail(2, e.message);
  }

  const { digest: want, repo } = resolveTarget();
  if (!want) fail(2, "Could not determine a sha256 digest (no registry digest on the local image?). Pass --digest, or push/pull the image first.");

  const maxAgeDays = arg("max-age");
  const quorum = Number(arg("quorum") || process.env.OATH_QUORUM || 1);
  const attestRepo = arg("attest") || process.env.OATH_ATTEST_REPO;
  let rec;
  try {
    rec = await findRecord({
      signers,
      digest: want,
      rpcUrl,
      limit: Number(arg("limit") || 1000),
      image: flag("no-bind") ? undefined : repo,
      maxAgeSeconds: maxAgeDays ? Number(maxAgeDays) * 86400 : undefined,
      quorum,
    });
  } catch (e) {
    fail(2, `RPC lookup failed: ${e.message}`);
  }

  if (rec) {
    let att = null;
    if (attestRepo) {
      try {
        att = await verifyAttestation({ digest: want, image: flag("no-bind") ? undefined : repo, repo: attestRepo });
      } catch (e) {
        fail(2, `attestation check failed: ${e.message}`);
      }
      if (!att.ok) {
        console.error(`NOT VERIFIED  ${want}`);
        console.error(`  The digest is anchored on Solana, but the build attestation check failed: ${att.reason}`);
        process.exit(1);
      }
    }
    console.log(`VERIFIED  ${want}`);
    console.log(`  built from commit ${rec.commit} (${rec.image})`);
    console.log(`  anchored at ${rec.anchoredAt} by ${rec.signers.join(" + ")}${quorum > 1 ? `  (quorum ${rec.signers.length}/${quorum} met)` : ""}`);
    console.log(`  tx ${rec.signature}`);
    if (att) console.log(`  build attestation OK: Sigstore-signed by ${att.workflow}`);
    process.exit(0);
  }

  console.error(`NOT VERIFIED  ${want}`);
  console.error(`  No pipeline build with this digest${repo ? ` for ${repo}` : ""} was anchored by ${quorum > 1 ? `${quorum} of ` : ""}${signers.join(" / ")}${maxAgeDays ? ` in the last ${maxAgeDays} days` : ""}.`);
  console.error("  Refusing to proceed: the image may have been replaced outside the pipeline.");
  process.exit(1);
}

// Checks every running container of the current cluster (or of a saved `kubectl get pods -A -o json`).
async function audit() {
  const signers = (arg("signer") || process.env.OATH_SIGNER || process.env.POD_SIGNER || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!signers.length) fail(2, "Missing --signer (or OATH_SIGNER).");
  let rpcUrl;
  try { rpcUrl = resolveRpc({ rpc: arg("rpc"), network: arg("network") }); } catch (e) { fail(2, e.message); }

  let raw;
  const file = arg("file");
  try {
    raw = file
      ? readFileSync(file === "-" ? 0 : file, "utf8")
      : execFileSync("kubectl", ["get", "pods", "-A", "-o", "json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    fail(2, `cannot read pods: ${(e.stderr || e.message).toString().trim()}`);
  }
  let list;
  try { list = JSON.parse(raw); } catch { fail(2, "pods input is not valid JSON"); }

  const skip = (arg("skip-namespaces") ?? "kube-system,kube-public,kube-node-lease,oath-system").split(",").filter(Boolean);
  const images = collectImages(list, { skipNamespaces: skip });
  const maxAgeDays = arg("max-age");
  const cache = new Map();
  let bad = 0;
  for (const im of images) {
    if (!im.digest) { bad++; console.log(`UNKNOWN      ${im.where}  ${im.image}  (no digest in imageID)`); continue; }
    const key = `${im.repo}@${im.digest}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, await findRecord({ signers, digest: im.digest, rpcUrl, limit: Number(arg("limit") || 1000), image: flag("no-bind") ? undefined : im.repo, maxAgeSeconds: maxAgeDays ? Number(maxAgeDays) * 86400 : undefined }));
      } catch (e) {
        fail(2, `RPC lookup failed: ${e.message}`);
      }
    }
    const rec = cache.get(key);
    if (rec) console.log(`VERIFIED     ${im.where}  ${im.image}  commit ${rec.commit}`);
    else { bad++; console.log(`NOT VERIFIED ${im.where}  ${im.image}  ${im.digest}`); }
  }
  console.log(`\n${images.length} containers checked, ${bad} not verified.`);
  process.exit(bad ? 1 : 0);
}

const cmd = process.argv[2];
if (cmd === "verify") {
  await verify();
} else if (cmd === "audit") {
  await audit();
} else {
  console.error("Usage: oath audit --signer <pubkey[,pubkey]> [--file pods.json|-] [--skip-namespaces a,b] [--network …]\n       oath verify --signer <pubkey[,pubkey]> (--digest sha256:… | --image <ref> | --container <name>) [--network devnet|mainnet | --rpc <url>] [--max-age <days>] [--quorum <N>] [--attest <owner/repo>] [--no-bind]");
  process.exit(2);
}

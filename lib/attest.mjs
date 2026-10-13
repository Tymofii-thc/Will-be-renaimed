// Verifies the SLSA build-provenance attestation that GitHub (Sigstore, keyless) issued for an image digest.
// Checks, in order: the bundle's signature chain + transparency log (sigstore), the signing identity (GitHub Actions of the
// expected repository), and that the signed statement is about exactly this digest (and image, if given).
import { repoName } from "./oath.mjs";

const ISSUER = "https://token.actions.githubusercontent.com";
const SLSA = "https://slsa.dev/provenance/";

export async function fetchBundles(repo, digest, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/attestations/${digest}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub attestations API: HTTP ${r.status}`);
  const j = await r.json();
  return (j.attestations || []).map((a) => a.bundle).filter(Boolean);
}

// -> { ok: true, identity, workflow } | { ok: false, reason }
export async function verifyAttestation({ digest, image, repo, token, fetchImpl, verifyImpl }) {
  let verify = verifyImpl;
  if (!verify) {
    try { ({ verify } = await import("sigstore")); }
    catch { throw new Error("attestation check needs the 'sigstore' package (npm install sigstore)"); }
  }
  const bundles = await fetchBundles(repo, digest, { token, fetchImpl });
  if (!bundles.length) return { ok: false, reason: `no build attestation found for ${digest} in ${repo}` };

  const wantHex = digest.replace(/^sha256:/, "");
  const wantRepo = repoName(image);
  const prefix = `https://github.com/${repo}/.github/workflows/`.toLowerCase();
  let lastReason = "no attestation matched";
  for (const bundle of bundles) {
    let stmt;
    try { stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8")); }
    catch { lastReason = "unreadable attestation payload"; continue; }
    if (!String(stmt.predicateType || "").startsWith(SLSA)) { lastReason = `unexpected predicate ${stmt.predicateType}`; continue; }
    const subject = (stmt.subject || []).find((s) => s.digest?.sha256 === wantHex && (!wantRepo || repoName(s.name) === wantRepo));
    if (!subject) { lastReason = "attestation is about a different digest or image"; continue; }
    let signer;
    try { signer = await verify(bundle, { certificateIssuer: ISSUER }); }
    catch (e) { lastReason = `signature/transparency-log verification failed: ${e.message}`; continue; }
    const san = signer?.identity?.subjectAlternativeName || "";
    if (!san.toLowerCase().startsWith(prefix)) { lastReason = `built by an unexpected identity: ${san || "unknown"}`; continue; }
    return { ok: true, identity: san, workflow: san.slice(`https://github.com/${repo}/`.length) };
  }
  return { ok: false, reason: lastReason };
}

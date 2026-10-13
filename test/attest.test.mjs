import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAttestation } from "../lib/attest.mjs";

const HEX = "a".repeat(64);
const D = "sha256:" + HEX;
const bundle = (stmt) => ({ dsseEnvelope: { payload: Buffer.from(JSON.stringify(stmt)).toString("base64") } });
const stmt = (o = {}) => ({ predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: "ghcr.io/me/app", digest: { sha256: HEX } }], ...o });
const api = (bundles, status = 200) => async () => ({ status, ok: status === 200, json: async () => ({ attestations: bundles.map((b) => ({ bundle: b })) }) });
const good = async () => ({ identity: { subjectAlternativeName: "https://github.com/me/app/.github/workflows/deploy.yml@refs/heads/main" } });
const args = { digest: D, image: "ghcr.io/me/app:latest", repo: "me/app" };

test("accepts a valid attestation from the expected repo's workflow", async () => {
  const r = await verifyAttestation({ ...args, fetchImpl: api([bundle(stmt())]), verifyImpl: good });
  assert.equal(r.ok, true);
  assert.equal(r.workflow, ".github/workflows/deploy.yml@refs/heads/main");
});

test("rejects when there is no attestation", async () => {
  const r = await verifyAttestation({ ...args, fetchImpl: api([], 404), verifyImpl: good });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no build attestation/);
});

test("rejects when signature verification fails", async () => {
  const r = await verifyAttestation({ ...args, fetchImpl: api([bundle(stmt())]), verifyImpl: async () => { throw new Error("bad sig"); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /bad sig/);
});

test("rejects an identity from another repository", async () => {
  const other = async () => ({ identity: { subjectAlternativeName: "https://github.com/attacker/app/.github/workflows/x.yml@refs/heads/main" } });
  const r = await verifyAttestation({ ...args, fetchImpl: api([bundle(stmt())]), verifyImpl: other });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected identity/);
});

test("rejects a statement about another digest or image", async () => {
  const wrongDigest = stmt({ subject: [{ name: "ghcr.io/me/app", digest: { sha256: "b".repeat(64) } }] });
  assert.equal((await verifyAttestation({ ...args, fetchImpl: api([bundle(wrongDigest)]), verifyImpl: good })).ok, false);
  const wrongImage = stmt({ subject: [{ name: "ghcr.io/me/other", digest: { sha256: HEX } }] });
  assert.equal((await verifyAttestation({ ...args, fetchImpl: api([bundle(wrongImage)]), verifyImpl: good })).ok, false);
});

test("rejects a non-SLSA predicate", async () => {
  const r = await verifyAttestation({ ...args, fetchImpl: api([bundle(stmt({ predicateType: "https://example.com/other" }))]), verifyImpl: good });
  assert.equal(r.ok, false);
});

test("API errors throw (fail closed, never 'verified')", async () => {
  await assert.rejects(() => verifyAttestation({ ...args, fetchImpl: api([], 500), verifyImpl: good }));
});

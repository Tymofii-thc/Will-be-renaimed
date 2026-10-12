import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandler } from "../lib/admission.mjs";
import { parseRef } from "../lib/registry.mjs";

const D1 = "sha256:" + "a".repeat(64);
const D2 = "sha256:" + "b".repeat(64);
const digests = { "ghcr.io/me/app:v1": D1, "ghcr.io/me/evil:latest": D2, "localhost:5000/x/app": D1 };
const anchored = new Set([D1]);

const deps = {
  resolveDigest: async (ref) => {
    if (ref.includes("@sha256:")) return ref.split("@")[1];
    if (!digests[ref]) throw new Error(`cannot resolve ${ref}`);
    return digests[ref];
  },
  findRecord: async ({ digest }) => (anchored.has(digest) ? { signature: "s" } : null),
};
const pod = (images, kind = "Pod") => ({
  request: { uid: "u1", kind: { kind }, object: { spec: { containers: images.map((image, i) => ({ name: `c${i}`, image })) } } },
});
const mk = (o = {}) => makeHandler({ signers: ["S"], rpcUrl: "x", deps, ...o });
const patchOf = (r) => JSON.parse(Buffer.from(r.response.patch, "base64"));

test("allows anchored image and pins tag to digest", async () => {
  const r = await mk()(pod(["ghcr.io/me/app:v1"]));
  assert.equal(r.response.allowed, true);
  assert.deepEqual(patchOf(r), [{ op: "replace", path: "/spec/containers/0/image", value: `ghcr.io/me/app@${D1}` }]);
});

test("pin keeps registry port intact", async () => {
  const r = await mk()(pod(["localhost:5000/x/app"]));
  assert.equal(patchOf(r)[0].value, `localhost:5000/x/app@${D1}`);
});

test("denies un-anchored image with a reason", async () => {
  const r = await mk()(pod(["ghcr.io/me/evil:latest"]));
  assert.equal(r.response.allowed, false);
  assert.match(r.response.status.message, /no pipeline build anchored/);
});

test("one bad container among good ones denies the pod", async () => {
  const r = await mk()(pod(["ghcr.io/me/app:v1", "ghcr.io/me/evil:latest"]));
  assert.equal(r.response.allowed, false);
});

test("fails closed when the image cannot be resolved", async () => {
  const r = await mk()(pod(["ghcr.io/me/missing:1"]));
  assert.equal(r.response.allowed, false);
});

test("fails closed when the Solana lookup throws", async () => {
  const h = makeHandler({ signers: ["S"], rpcUrl: "x", deps: { ...deps, findRecord: async () => { throw new Error("rpc down"); } } });
  const r = await h(pod(["ghcr.io/me/app:v1"]));
  assert.equal(r.response.allowed, false);
  assert.match(r.response.status.message, /rpc down/);
});

test("already-pinned image is verified but not patched", async () => {
  const r = await mk()(pod([`ghcr.io/me/app@${D1}`]));
  assert.equal(r.response.allowed, true);
  assert.equal(r.response.patch, undefined);
});

test("audit mode allows but warns", async () => {
  const r = await mk({ mode: "audit" })(pod(["ghcr.io/me/evil:latest"]));
  assert.equal(r.response.allowed, true);
  assert.match(r.response.warnings[0], /refusing/);
});

test("non-Pod objects pass through", async () => {
  const r = await mk()(pod(["ghcr.io/me/evil:latest"], "ConfigMap"));
  assert.equal(r.response.allowed, true);
});

test("parseRef", () => {
  assert.deepEqual(parseRef("nginx"), { registry: "docker.io", repo: "library/nginx", tag: "latest", digest: null });
  assert.deepEqual(parseRef("ghcr.io/me/app:v1"), { registry: "ghcr.io", repo: "me/app", tag: "v1", digest: null });
  assert.equal(parseRef(`ghcr.io/me/app@${D1}`).digest, D1);
  assert.equal(parseRef("localhost:5000/x/app").registry, "localhost:5000");
});

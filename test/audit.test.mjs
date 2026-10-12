import { test } from "node:test";
import assert from "node:assert/strict";
import { collectImages } from "../lib/audit.mjs";

const D1 = "sha256:" + "a".repeat(64);
const D2 = "sha256:" + "b".repeat(64);
const pod = (ns, name, statuses, phase = "Running") => ({ metadata: { namespace: ns, name }, status: { phase, containerStatuses: statuses } });

test("collects digest and repo from imageID", () => {
  const r = collectImages({ items: [pod("app", "p", [{ name: "c", image: "ghcr.io/me/app:v1", imageID: `ghcr.io/me/app@${D1}` }])] });
  assert.deepEqual(r, [{ where: "app/p/c", image: "ghcr.io/me/app:v1", digest: D1, repo: "ghcr.io/me/app" }]);
});

test("handles docker-pullable:// prefix and bare sha256 imageID", () => {
  const r = collectImages({ items: [pod("a", "p", [
    { name: "x", image: "alpine:3.20", imageID: `docker-pullable://alpine@${D1}` },
    { name: "y", image: "ghcr.io/me/y:1", imageID: D2 },
  ])] });
  assert.equal(r[0].repo, "docker.io/library/alpine");
  assert.equal(r[1].repo, "ghcr.io/me/y");
  assert.equal(r[1].digest, D2);
});

test("skips namespaces and finished pods, flags missing digest", () => {
  const r = collectImages({ items: [
    pod("kube-system", "dns", [{ name: "c", image: "x", imageID: `x@${D1}` }]),
    pod("app", "done", [{ name: "c", image: "x", imageID: `x@${D1}` }], "Succeeded"),
    pod("app", "pending", [{ name: "c", image: "x", imageID: "" }], "Pending"),
  ] }, { skipNamespaces: ["kube-system"] });
  assert.equal(r.length, 1);
  assert.equal(r[0].digest, null);
});

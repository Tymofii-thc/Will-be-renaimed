// Audit of what is ALREADY running: turns `kubectl get pods -A -o json` into (repo, digest) pairs to verify.
import { extractDigest, repoName } from "./oath.mjs";

// imageID looks like "docker.io/library/alpine@sha256:…" (containerd/docker) or "docker-pullable://repo@sha256:…".
export function collectImages(podList, { skipNamespaces = [] } = {}) {
  const found = [];
  for (const pod of podList?.items || []) {
    const ns = pod.metadata?.namespace || "";
    if (skipNamespaces.includes(ns)) continue;
    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;
    const statuses = [
      ...(pod.status?.initContainerStatuses || []),
      ...(pod.status?.containerStatuses || []),
      ...(pod.status?.ephemeralContainerStatuses || []),
    ];
    for (const cs of statuses) {
      const id = (cs.imageID || "").replace(/^docker-pullable:\/\//, "");
      const digest = extractDigest(id);
      const where = `${ns}/${pod.metadata?.name}/${cs.name}`;
      if (!digest) { found.push({ where, image: cs.image, digest: null, repo: null }); continue; }
      // prefer the repo from imageID; if it is just "sha256:…" fall back to the image reference
      const repo = id.includes("@") ? repoName(id) : repoName(cs.image);
      found.push({ where, image: cs.image, digest, repo });
    }
  }
  return found;
}

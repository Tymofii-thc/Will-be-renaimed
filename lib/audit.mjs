// Audit of what is ALREADY running: turns `kubectl get pods -A -o json` into (repo, digest) pairs to verify.
import { readFileSync } from "node:fs";
import https from "node:https";
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

// Lists every Pod through the Kubernetes API using the Pod's own service account (what `oath audit --in-cluster` runs in a CronJob).
export function listPodsInCluster({ dir = "/var/run/secrets/kubernetes.io/serviceaccount", env = process.env } = {}) {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT || "443";
  if (!host) return Promise.reject(new Error("not running inside a cluster (KUBERNETES_SERVICE_HOST is not set)"));
  const token = readFileSync(`${dir}/token`, "utf8").trim();
  const ca = readFileSync(`${dir}/ca.crt`);
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: "/api/v1/pods", method: "GET", ca, headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Kubernetes API answered HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error("Kubernetes API returned invalid JSON")); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

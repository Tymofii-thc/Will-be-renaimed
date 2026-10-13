// Kubernetes AdmissionReview handler: allow a Pod only if every image was anchored by the pipeline.
import { findRecord, repoName } from "./oath.mjs";
import { parseRef, resolveDigest } from "./registry.mjs";
import { verifyAttestation } from "./attest.mjs";

function containerSlots(pod) {
  const spec = pod?.spec || {};
  const out = [];
  for (const key of ["initContainers", "containers", "ephemeralContainers"]) {
    (spec[key] || []).forEach((c, i) => out.push({ path: `/spec/${key}/${i}/image`, image: c.image }));
  }
  return out;
}

export function makeHandler({ signers, rpcUrl, maxAgeSeconds, quorum = 1, attestRepo, mode = "enforce", pin = true, auths = {}, cacheMs = 300000, deps = {} }) {
  const resolve = deps.resolveDigest || resolveDigest;
  const find = deps.findRecord || findRecord;
  const attest = deps.verifyAttestation || verifyAttestation;
  const cache = new Map(); // `${repo}@${digest}` -> { rec, exp }

  async function check(image) {
    const digest = await resolve(image, { auths });
    const repo = repoName(image);
    const key = `${repo}@${digest}`;
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return { digest, rec: hit.rec, why: hit.why };
    let rec = await find({ signers, digest, rpcUrl, image, maxAgeSeconds, quorum });
    let why = "";
    if (rec && attestRepo) {
      const att = await attest({ digest, image, repo: attestRepo });
      if (!att.ok) { rec = null; why = `anchored, but build attestation failed: ${att.reason}`; }
    }
    cache.set(key, { rec, why, exp: Date.now() + (rec ? cacheMs : 15000) }); // a miss is re-checked soon: the build may just have been anchored
    return { digest, rec, why };
  }

  return async function review(body) {
    const req = body?.request;
    const uid = req?.uid || "";
    const respond = (allowed, message, patch, warnings) => ({
      apiVersion: "admission.k8s.io/v1",
      kind: "AdmissionReview",
      response: {
        uid,
        allowed,
        ...(message ? { status: { code: allowed ? 200 : 403, message } } : {}),
        ...(warnings?.length ? { warnings } : {}),
        ...(patch?.length ? { patchType: "JSONPatch", patch: Buffer.from(JSON.stringify(patch)).toString("base64") } : {}),
      },
    });
    if (!req || req.kind?.kind !== "Pod") return respond(true);

    const patch = [];
    const failures = [];
    for (const slot of containerSlots(req.object)) {
      try {
        const { digest, rec, why } = await check(slot.image);
        if (!rec) {
          failures.push(`${slot.image} (${digest}): ${why || `no pipeline build anchored by ${quorum > 1 ? `${quorum} of ` : ""}the trusted signer(s)`}`);
        } else if (pin && !parseRef(slot.image).digest) {
          patch.push({ op: "replace", path: slot.path, value: `${slot.image.replace(/:[^:/@]+$/, "")}@${digest}` });
        }
      } catch (e) {
        failures.push(`${slot.image}: ${e.message}`); // can't verify => don't run (fail closed)
      }
    }

    if (failures.length) {
      const msg = `oath: refusing to admit pod. ${failures.join("; ")}`;
      return mode === "audit" ? respond(true, null, null, [msg]) : respond(false, msg);
    }
    return respond(true, null, patch);
  };
}

// Core verification logic shared by the CLI (bin/oath.mjs) and the admission webhook (bin/oath-webhook.mjs).
export const NETWORKS = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
};

export function resolveRpc({ rpc, network, env = process.env } = {}) {
  if (rpc) return rpc;
  if (env.SOLANA_RPC) return env.SOLANA_RPC;
  const n = network || env.OATH_NETWORK || "devnet";
  if (!NETWORKS[n]) throw new Error(`Unknown network "${n}" (use devnet, mainnet, or --rpc <url>)`);
  return NETWORKS[n];
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

// "ghcr.io/Me/App:latest" and "ghcr.io/me/app@sha256:..." -> "ghcr.io/me/app"
export function repoName(ref) {
  if (!ref) return null;
  let r = ref.replace(/@sha256:[0-9a-f]{64}$/i, "");
  const slash = r.lastIndexOf("/");
  const colon = r.lastIndexOf(":");
  if (colon > slash) r = r.slice(0, colon);
  const parts = r.split("/");
  if (parts.length === 1) r = `docker.io/library/${r}`;
  else if (!/[.:]/.test(parts[0]) && parts[0] !== "localhost") r = `docker.io/${r}`;
  return r.toLowerCase();
}

export async function rpcCall(url, method, params) {
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

// Looks for a successful anchor of `digest` by any of `signers`, newest first, paging back up to `limit` txs per signer.
// opts.image: if set, the record's image name must equal repoName(image).
// opts.maxAgeSeconds: if set, the anchoring tx must be newer than that.
// Throws on RPC errors (callers decide whether that means "deny" or "usage error").
export async function findRecord({ signers, digest, rpcUrl, limit = 1000, image, maxAgeSeconds, now = Date.now() }) {
  const want = repoName(image);
  for (const signer of signers) {
    let before;
    let seen = 0;
    while (seen < limit) {
      const page = Math.min(1000, limit - seen);
      const sigs = await rpcCall(rpcUrl, "getSignaturesForAddress", [signer, { limit: page, ...(before ? { before } : {}) }]);
      if (!sigs.length) break;
      for (const s of sigs) {
        if (s.err) continue;
        for (const rec of parseMemo(s.memo)) {
          if (rec.digest !== digest) continue;
          if (want && repoName(rec.image) !== want) continue;
          const t = s.blockTime ? s.blockTime * 1000 : Date.parse(rec.ts);
          if (maxAgeSeconds && now - t > maxAgeSeconds * 1000) continue;
          return { ...rec, signer, signature: s.signature, anchoredAt: new Date(t).toISOString() };
        }
      }
      seen += sigs.length;
      before = sigs[sigs.length - 1].signature;
      if (sigs.length < page) break;
    }
  }
  return null;
}

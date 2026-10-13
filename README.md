<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="verifier/assets/logo-white.svg">
    <img src="verifier/assets/logo-black.svg" alt="oath." height="64">
  </picture>
</p>

**English** · [Українська](README.uk.md)

*Don't deploy what the pipeline didn't build.*

Oath stops a container image from reaching production unless your own pipeline built it. Live verifier: **https://tymofii-thc.github.io/oath/**

**Problem.** A swapped image in the registry, a manual `docker push` that bypasses CI, a compromised token: nobody notices that production runs something other than what was built. That is a supply-chain attack, and the code in git can be perfectly clean.

**Solution.** Every CI build records `commit → image digest → time` on Solana as a standard Memo transaction signed by the CI key (no custom smart contract). Before deploy, `oath verify` checks the digest of the image about to run against those records and **stops the deploy** if there is none.

```
build ──► image digest ──► Solana Memo tx (signed by the CI key)
                                  │
deploy ──► docker pull ──► oath verify ──► ✔ exit 0  → deploy proceeds
                                         ✘ exit 1  → deploy stopped
```

`oath` below means `node bin/oath.mjs` (or `npx --yes --allow-git=all github:Tymofii-thc/oath`).

## Set up in 3 steps

**1. A CI key** (once, about a minute):
```bash
npx --yes --allow-git=all github:Tymofii-thc/oath init      # or: node bin/oath.mjs init  in a clone
```
`oath init` creates a key in `.oath/ci-key.json` (the secret is never printed and `.oath/` goes into `.gitignore`), asks the devnet faucet for SOL, and if the public faucet refuses (it often does) it prints the link and **waits until you've funded the key**. It then prints exactly what to add to your repository: the secret `SOLANA_SECRET_KEY`, the variable `OATH_SIGNER`, and the two workflow steps below. With the GitHub CLI installed and logged in, `oath init --set-github` sets the secret and variable for you.

**2. Record after the build** (in your workflow):
```yaml
- uses: Tymofii-thc/oath@main
  with:
    image: ghcr.io/${{ github.repository }}
    digest: ${{ steps.build.outputs.digest }}
    secret-key: ${{ secrets.SOLANA_SECRET_KEY }}
```

**3. Verify before deploy** (no npx, no flags):
```yaml
- uses: Tymofii-thc/oath/verify@main
  with:
    signer: ${{ vars.OATH_SIGNER }}
    image: ghcr.io/${{ github.repository }}:latest
```
The action pulls the image and fails the job (exit 1) if the digest has no record. Optional inputs: `network`, `rpc`, `quorum`, `max-age`, `attest` (see below), or `digest` instead of `image`.

This repository dogfoods the same flow: see `.github/workflows/deploy.yml`. Step-by-step testing guide: [TESTING.md](TESTING.md).

## CLI
```bash
oath verify --signer <pubkey> --digest sha256:…
oath verify --signer <pubkey> --image ghcr.io/me/app:latest
oath verify --signer <pubkey> --container prod      # the image that is running RIGHT NOW
oath audit  --signer <pubkey>                       # every Pod running in the current kube context
```
Exit codes: `0` verified, `1` not verified, `2` error (network, arguments). Options: `--network devnet|mainnet` or `--rpc <url>`, `--max-age <days>`, `--quorum <N>`, `--attest <owner/repo>`, `--no-bind`.

`verifier/` is the same check in the browser, for demos and for people who avoid the terminal.

## Protecting the cluster (Kubernetes admission webhook)
A CI step can't stop someone who runs `kubectl apply` directly. So there is a webhook inside the cluster:

```bash
OATH_SIGNER=<public key> OATH_NETWORK=mainnet deploy/install.sh   # generates TLS, installs into namespace oath-system
kubectl run t --image=nginx        # → denied: no pipeline build anchored by the trusted signer(s)
```
- For each new Pod it takes every image (`initContainers`, `containers`, `ephemeralContainers`), resolves the tag to a digest through the registry and looks for a record on Solana. No record: the Pod is not created (including Pods of Deployments and Jobs).
- **Pins the tag to the verified digest** (`app:latest` → `app@sha256:…`), so the kubelet pulls exactly what was verified and the tag can't be moved between check and pull.
- **Fails closed:** an unreachable registry, RPC or the webhook itself means the Pod is rejected (`failurePolicy: Fail`). Exempt: `kube-system`, `kube-public`, `kube-node-lease` and `oath-system`, so the cluster can't lock itself out.
- `OATH_MODE=audit` allows everything but returns warnings: useful for a first rollout.
- `OATH_FAILURE_POLICY=Ignore deploy/install.sh` sets `failurePolicy: Ignore` (availability over enforcement; combine with `oath audit`). The webhook runs 2 replicas with a PodDisruptionBudget.
- Private registries: `OATH_REGISTRY_AUTH='{"ghcr.io":{"username":"u","password":"token"}}'` (tested against a password-protected registry and a mock token registry; note that the kubelet still needs its own `imagePullSecrets` to pull the image).
- Tested in a real cluster (kind): `test/e2e-kind.sh` covers admit, tag pinning, deny, Deployment pods blocked, and fail-closed with the webhook down.

## Pods that are already running
The webhook only checks new Pods. For the ones already running:
```bash
oath audit --signer <pubkey> --network mainnet [--skip-namespaces kube-system,…] [--file pods.json]
```
It reads every container of the current kube context (`kubectl get pods -A -o json`, using the real digests from `imageID`), checks them against the records and exits 1 if anything is unverified. Tested in kind: Pods created before the webhook are found (`alpine` VERIFIED, `nginx` NOT VERIFIED).

## Build attestation (SLSA provenance)
A record on Solana proves "the signer recorded this digest", not "the build was honest". So CI also issues a build-provenance attestation through GitHub/Sigstore (keyless, no long-lived key), and `oath verify` can require it:
```bash
oath verify --signer <pubkey> --image ghcr.io/me/app:latest --attest me/app
```
It checks the cryptographic signature and the Sigstore transparency-log entry (via the `sigstore` library, Fulcio certificate chain), that the signer is GitHub Actions of the repository `me/app` (workflow identity), and that the signed statement is about exactly this digest and image. A missing attestation, a different repository, a different digest or an API error gives `NOT VERIFIED` (exit 1) or exit 2, never "ok". For the webhook: `OATH_ATTEST_REPO=me/app deploy/install.sh`. Tested against our CI's real attestation, including negative cases (another repository, an image without an attestation).

## Signer quorum (against a stolen CI key)
One key in CI secrets is a single point of failure. So an image can be accepted only if **N different keys** each recorded its digest:
```bash
# the CI key records automatically; a human approver records with their own key (laptop, separate device):
SOLANA_SECRET_KEY="$(cat approver.json)" node scripts/anchor.mjs --image ghcr.io/me/app --digest sha256:… --commit <sha>
# before deploy:
oath verify --signer <ciKey>,<approverKey> --quorum 2 --image ghcr.io/me/app:latest      # webhook: OATH_QUORUM=2
```
Someone who steals the CI key can record a forged digest but cannot produce the approver's second record, so the quorum is not met. Tested on live devnet: a digest with two records passes (`quorum 2/2`), a digest with only the CI record does not.

**About hardware keys, honestly.** A quorum protects you if the approver key is kept separately from CI. Signing with a hardware key *inside CI* is impossible (there is no device), and signing with a Ledger or wallet is **not implemented or tested** in this tool: `anchor.mjs` signs with a key from a file. Hardware storage of the approver key is up to the operator; we only guarantee that without a second independent record the deploy does not pass.

## Mainnet
Everything works the same way: `--network mainnet` (CLI), `OATH_NETWORK=mainnet` (webhook), `?net=mainnet` or the dropdown (page), and for recording in CI the action's `rpc` input (or the repository variable `SOLANA_RPC`). A record costs roughly 0.000005 SOL in fees. The browser verifier uses `solana-rpc.publicnode.com` for mainnet because `api.mainnet-beta.solana.com` answers 403 to every browser request (the `Origin` header); the CLI and webhook are unaffected. The public `api.mainnet-beta.solana.com` is rate-limited; for production use your own RPC (Helius, QuickNode, …) via `--rpc` / `SOLANA_RPC`. We have **not** run CI on live mainnet yet; there is a manual `anchor-mainnet` workflow for it.

## Keys: rotation, revocation, expiry
- `--signer a,b` / `OATH_SIGNER=a,b` accepts several keys (a record from any one is enough unless `--quorum` is set). **Rotation:** add the new key → switch CI → remove the old key after a grace period.
- **Revocation:** remove the compromised key from the list; all its records stop counting immediately (this is verification policy, not on-chain data).
- `--max-age <days>`: old records are not accepted, so a stolen old digest doesn't live forever.
- A record is bound to the image name: a digest recorded for `ghcr.io/me/other` will not verify `ghcr.io/me/app` (disable with `--no-bind`).
- Verification pages through the signer's history (up to `--limit` transactions, 1000 by default), not just the latest 100.

## Vulnerability scanning (optional)
Oath proves provenance, not safety. To avoid recording vulnerable images, set the repository variable `OATH_SCAN=true`: Trivy then checks the image for fixable CRITICAL vulnerabilities before recording, and if it finds any no record is written, so the `deploy` step fails.

## Demo (3 minutes)
1. **Problem** (20 s): "How do you prove production runs what the pipeline built?"
2. **Normal deploy** (40 s): push → build → record on Solana (show the transaction in Explorer) → `oath verify` says VERIFIED → deploy proceeds.
3. **Attack** (60 s): build a different image and push it to the same tag, bypassing CI; then `docker pull` + `oath verify`: **NOT VERIFIED, exit 1, deploy stopped.** A scripted version that runs against a local registry is in `demo/demo.sh`.
4. **Why a blockchain** (30 s): neither a CI admin nor someone with registry access can rewrite the record.
5. **Next** (30 s): mainnet in CI, hardware-wallet approvers, verifying attestations inside the webhook for private registries.

## Limitations (we say them before you ask)
- **CI key.** Whoever steals `SOLANA_SECRET_KEY` can record a forged digest. A quorum with an independent approver key closes this, but it needs a human in the loop and a separately stored key; without a quorum you only get mitigations (rotation, revocation, `--max-age`, image binding). Hardware keys and Ledger signing are **not implemented**.
- **Honesty of the build.** A Solana record only proves "the signer recorded this digest". `--attest` verifies the SLSA build attestation (Sigstore) and proves that the named repository's workflow built the digest, but not that the code itself is safe (the optional Trivy gate covers known vulnerabilities).
- **Network.** devnet by default (free, but no retention guarantees). Mainnet is supported but not exercised in CI.
- **Registry and RPC as dependencies.** The webhook fails closed, so while the RPC or registry is unreachable new Pods are not created (running Pods are untouched). Production needs a reliable RPC.
- **Pods created before the webhook was installed** are not checked; only new ones (CREATE) are. Use `oath audit` for existing ones.
- Closest alternative without a blockchain: Sigstore/Rekor. Our difference: a public ledger that doesn't depend on a single operator.

## Tests
```bash
npm test                      # unit tests (mocked Solana RPC, quorum, attestations, admission logic, audit)
OATH_SIGNER=… OK_IMAGE=alpine:3.20 BAD_IMAGE=nginx:alpine test/e2e-kind.sh   # needs docker, kind, kubectl
```

## License
MIT, see [LICENSE](LICENSE).

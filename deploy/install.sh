#!/usr/bin/env bash
# Installs the oath admission webhook into the current kubectl context.
# Usage: OATH_SIGNER=<pubkey[,pubkey]> [OATH_NETWORK=devnet|mainnet] [OATH_IMAGE=ghcr.io/…/oath:latest] deploy/install.sh
set -euo pipefail
: "${OATH_SIGNER:?set OATH_SIGNER to the CI signer public key (comma-separate several)}"
OATH_NETWORK="${OATH_NETWORK:-devnet}"
OATH_IMAGE="${OATH_IMAGE:-ghcr.io/tymofii-thc/oath-webhook:latest}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
svc=oath-webhook; ns=oath-system

openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=oath-ca" -keyout "$tmp/ca.key" -out "$tmp/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$svc.$ns.svc" -keyout "$tmp/tls.key" -out "$tmp/tls.csr" 2>/dev/null
printf "subjectAltName=DNS:%s,DNS:%s.%s,DNS:%s.%s.svc\n" "$svc" "$svc" "$ns" "$svc" "$ns" > "$tmp/san.ext"
openssl x509 -req -in "$tmp/tls.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" -CAcreateserial -days 825 -extfile "$tmp/san.ext" -out "$tmp/tls.crt" 2>/dev/null

kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"
kubectl label ns "$ns" oath.io/exempt=true --overwrite >/dev/null
kubectl -n "$ns" create secret tls oath-webhook-tls --cert="$tmp/tls.crt" --key="$tmp/tls.key" --dry-run=client -o yaml | kubectl apply -f -

ca="$(base64 -w0 < "$tmp/ca.crt")"
sed -e "s|__OATH_IMAGE__|$OATH_IMAGE|" -e "s|__OATH_SIGNER__|$OATH_SIGNER|" -e "s|__OATH_NETWORK__|$OATH_NETWORK|" -e "s|__CA_BUNDLE__|$ca|" "$here/k8s/oath.yaml" | kubectl apply -f -
kubectl -n "$ns" rollout status deploy/oath-webhook --timeout=120s
echo "oath is enforcing. Test: kubectl run t --image=nginx  (expected: denied)"

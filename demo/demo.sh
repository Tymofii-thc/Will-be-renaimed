#!/usr/bin/env bash
# Scripted demo: normal deploy, then an attack, against a throwaway local registry and Solana devnet.
# Needs: docker, node, npm ci done, and a FUNDED devnet CI key:
#   SOLANA_SECRET_KEY='[12,34,…]' demo/demo.sh        (node scripts/keygen.mjs creates one; fund it at https://faucet.solana.com)
set -u
: "${SOLANA_SECRET_KEY:?set SOLANA_SECRET_KEY to the JSON array of a funded devnet key}"
cd "$(dirname "$0")/.."
export SOLANA_SECRET_KEY
SIGNER=$(node --input-type=module -e 'import { Keypair } from "@solana/web3.js"; console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY))).publicKey.toBase58())')
REG=localhost:5055; IMG=$REG/demo/app
step(){ printf '\n\033[1;36m### %s\033[0m\n' "$1"; }
run(){ printf '\033[2m$ %s\033[0m\n' "$*"; "$@"; }
cleanup(){ docker rm -f demo-reg >/dev/null 2>&1; docker rmi "$IMG:latest" >/dev/null 2>&1; rm -rf "$EVIL"; }
EVIL=$(mktemp -d); trap cleanup EXIT

docker rm -f demo-reg >/dev/null 2>&1
docker run -d --name demo-reg -p 5055:5000 registry:2 >/dev/null; sleep 2

step "1. Normal deploy: CI builds the image and pushes it to the registry"
run docker build -q -t $IMG:latest app
run docker push -q $IMG:latest
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' $IMG:latest | sed 's/.*@//')
echo "digest in the registry: $DIGEST"

step "CI records the digest on Solana (devnet)"
run node scripts/anchor.mjs --image $IMG --digest "$DIGEST" --commit "$(git rev-parse HEAD 2>/dev/null || echo 0000000000000000)"
sleep 4

step "Before deploy: pull + oath verify"
run docker pull -q $IMG:latest
run node bin/oath.mjs verify --signer "$SIGNER" --image $IMG:latest; echo "exit code: $?"

step "2. Attack: someone pushes a different image to the same tag, bypassing CI"
printf 'FROM alpine:3.20\nRUN echo backdoor > /x\nCMD ["sleep","300"]\n' > "$EVIL/Dockerfile"
run docker build -q -t $IMG:latest "$EVIL"
run docker push -q $IMG:latest
docker rmi $IMG:latest >/dev/null

step "Deploy pulls :latest and verifies"
run docker pull -q $IMG:latest
run node bin/oath.mjs verify --signer "$SIGNER" --image $IMG:latest; echo "exit code: $?  -> deploy stopped"

#!/usr/bin/env bash
# Prints the registry digest of the image that is ACTUALLY running in a container.
# Usage: ./scripts/running-digest.sh <container-name>
set -euo pipefail

name="${1:?Usage: $0 <container-name>}"
image_id=$(docker inspect --format '{{.Image}}' "$name")
docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" | head -n1

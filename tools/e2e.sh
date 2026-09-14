#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="joo-ssh-client-e2e"
CONTAINER_NAME="joo-ssh-client-e2e"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_ID=""

cleanup() {
  if [[ -n "${CONTAINER_ID}" ]]; then
    echo "==> Stopping E2E container"
    docker rm -f "${CONTAINER_ID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run SSH E2E tests, but it was not found on PATH." >&2
  exit 1
fi

cd "${ROOT_DIR}"

echo "==> Building SSH client package"
npm run build

echo "==> Building Docker image ${IMAGE_NAME}:latest"
docker build -t "${IMAGE_NAME}:latest" docker

echo "==> Generating throwaway SSH password"
SSH_PASSWORD="$(openssl rand -hex 8)"

echo "==> Removing any stale SSH E2E container"
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

echo "==> Starting SSH E2E container"
CONTAINER_ID="$(docker run -d --rm --name "${CONTAINER_NAME}" -p 127.0.0.1::22 -e SSH_PASSWORD="${SSH_PASSWORD}" "${IMAGE_NAME}:latest")"
echo "Container: ${CONTAINER_ID}"

SSH_PORT="$(docker port "${CONTAINER_ID}" 22/tcp | awk -F: '{print $NF}')"
if [[ -z "${SSH_PORT}" ]]; then
  echo "Unable to determine mapped SSH port." >&2
  exit 1
fi
echo "Mapped SSH port: ${SSH_PORT}"

echo "==> Waiting for sshd readiness"
HOST_KEY=""
for _ in {1..30}; do
  if HOST_KEY="$(ssh-keyscan -t ed25519 -p "${SSH_PORT}" 127.0.0.1 2>/dev/null)" && [[ -n "${HOST_KEY}" ]]; then
    break
  fi

  sleep 1
done

if [[ -z "${HOST_KEY}" ]]; then
  echo "sshd did not become ready within 30 seconds." >&2
  exit 1
fi

echo "==> Computing pinned host fingerprint"
SSH_HOST_FINGERPRINT="$(printf '%s\n' "${HOST_KEY}" | ssh-keygen -lf - | awk '{print $2}')"
if [[ -z "${SSH_HOST_FINGERPRINT}" ]]; then
  echo "Unable to compute SSH host fingerprint." >&2
  exit 1
fi
echo "Host fingerprint: ${SSH_HOST_FINGERPRINT}"

export SSH_HOST="127.0.0.1"
export SSH_PORT
export SSH_USER="tester"
export SSH_PASSWORD
export SSH_HOST_FINGERPRINT

echo "==> Running Vitest E2E suite"
npx vitest run --config vitest.e2e.config.ts

#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:-}"
ARCHIVE="${2:-}"
MANIFEST="${3:-}"
COMMIT="${4:-}"
DEPLOY_ROOT="${TORVYE_DEPLOY_ROOT:-/home/ubuntu/torvye/codex_proxy}"
HOST_ROOT="$(dirname -- "${DEPLOY_ROOT}")"
LOCK_FILE="${HOST_ROOT}/.preproduction-deploy.lock"
FAILPOINT="${TORVYE_DEPLOY_FAILPOINT:-}"

if [[ "${ROLE}" != gateway && "${ROLE}" != worker ]]; then
  echo "Usage: install-release.sh <gateway|worker> <archive> <manifest> <commit>" >&2
  exit 1
fi
if [[ ! "${COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Release commit must be a full lowercase Git SHA." >&2
  exit 1
fi
for file in "${ARCHIVE}" "${MANIFEST}"; do
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "Release input is missing or is a symbolic link: ${file}" >&2
    exit 1
  fi
done
if [[ ! -d "${DEPLOY_ROOT}" || -L "${DEPLOY_ROOT}" ]]; then
  echo "Deployment root is missing or unsafe: ${DEPLOY_ROOT}" >&2
  exit 1
fi
if [[ -n "${FAILPOINT}" && "${FAILPOINT}" != after-activate-before-verify ]]; then
  echo "Unsupported deployment failpoint." >&2
  exit 1
fi

install -d -m 700 "${HOST_ROOT}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "Another TORVYE deployment is already running." >&2
  exit 1
fi

STAGING="$(mktemp -d "${HOST_ROOT}/.release-${COMMIT:0:12}.XXXXXX")"
BACKUP_ROOT="${DEPLOY_ROOT}/.deploy-backups"
BACKUP="${BACKUP_ROOT}/$(date -u +%Y%m%dT%H%M%SZ)-${ROLE}-${COMMIT:0:12}"
NEW_FILES="${STAGING}/.release-files"
ARCHIVE_FILES="${STAGING}/.archive-files"
SORTED_MANIFEST="${STAGING}/.manifest-files"
PREVIOUS_FILES="${DEPLOY_ROOT}/.deployed-files"
BACKUP_FILES="${STAGING}/.backup-files"
BACKUP_CANDIDATES="${STAGING}/.backup-candidates"
ENV_FILE="${DEPLOY_ROOT}/deploy/preproduction-split/.${ROLE}.runtime.env"
ENV_BACKUP="${STAGING}/runtime.env.before"
SOURCE_BACKUP="${STAGING}/source-before.tar.gz"
COMPOSE_FILE="${DEPLOY_ROOT}/deploy/preproduction-split/${ROLE}.compose.yaml"
SERVICE="$([[ "${ROLE}" == gateway ]] && printf gateway || printf provider-worker)"
VERIFY_SCRIPT="${DEPLOY_ROOT}/deploy/preproduction-split/scripts/verify-${ROLE}.sh"
NEW_IMAGE="torvye-ai-runtime:${COMMIT:0:12}"
ROLLED_BACK=false
SWITCH_STARTED=false

cleanup() {
  rm -rf -- "${STAGING}"
}

set_env() {
  local name="$1"
  local value="$2"
  local temporary="${ENV_FILE}.${$}.tmp"
  awk -F= -v key="${name}" '$1 != key { print }' "${ENV_FILE}" > "${temporary}"
  printf '%s=%s\n' "${name}" "${value}" >> "${temporary}"
  chmod 600 "${temporary}"
  mv -f -- "${temporary}" "${ENV_FILE}"
}

validate_manifest() {
  local entry
  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    if [[
      -z "${entry}" ||
      "${entry}" = /* ||
      "${entry}" == ".." ||
      "${entry}" == ../* ||
      "${entry}" == */../* ||
      "${entry}" == */.. ||
      ! "${entry}" =~ ^[A-Za-z0-9._/@+-]+$ ||
      "${entry}" =~ ^deploy/preproduction-split/(\.(gateway|worker)\.runtime\.env|state/|secrets/)
    ]]; then
      echo "Release manifest contains an unsafe path." >&2
      exit 1
    fi
  done < "${MANIFEST}"
  LC_ALL=C sort -u "${MANIFEST}" > "${SORTED_MANIFEST}"
  if ! cmp -s "${MANIFEST}" "${SORTED_MANIFEST}"; then
    echo "Release manifest must be sorted and contain unique paths." >&2
    exit 1
  fi
}

validate_archive() {
  local entry
  tar -tzf "${ARCHIVE}" > "${ARCHIVE_FILES}.all"
  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    entry="${entry%/}"
    [[ -n "${entry}" ]] || continue
    if [[
      "${entry}" = /* ||
      "${entry}" == ".." ||
      "${entry}" == ../* ||
      "${entry}" == */../* ||
      "${entry}" == */.. ||
      ! "${entry}" =~ ^[A-Za-z0-9._/@+-]+$
    ]]; then
      echo "Release archive contains an unsafe path." >&2
      exit 1
    fi
  done < "${ARCHIVE_FILES}.all"
  if tar -tvzf "${ARCHIVE}" |
    LC_ALL=C awk 'substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { found = 1 } END { exit(found ? 0 : 1) }'; then
    echo "Release archives may not contain symbolic or hard links." >&2
    exit 1
  fi
  sed -e '/\/$/d' "${ARCHIVE_FILES}.all" |
    LC_ALL=C sort > "${ARCHIVE_FILES}"
  if ! cmp -s "${SORTED_MANIFEST}" "${ARCHIVE_FILES}"; then
    echo "Release archive does not match its tracked-file manifest." >&2
    exit 1
  fi
}

docker_compose() {
  sudo docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

restore_source() {
  local entry
  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    [[ -n "${entry}" ]] || continue
    rm -f -- "${DEPLOY_ROOT}/${entry}"
  done < "${NEW_FILES}"
  tar -xzf "${SOURCE_BACKUP}" -C "${DEPLOY_ROOT}"
  if [[ -s "${BACKUP}/deployed-files.before" ]]; then
    cp -- "${BACKUP}/deployed-files.before" "${PREVIOUS_FILES}"
  else
    rm -f -- "${PREVIOUS_FILES}"
  fi
  if [[ -s "${BACKUP}/deployed-commit.before" ]]; then
    cp -- "${BACKUP}/deployed-commit.before" "${DEPLOY_ROOT}/.deployed-commit"
  else
    rm -f -- "${DEPLOY_ROOT}/.deployed-commit"
  fi
}

rollback() {
  local exit_code="${1:-$?}"
  local rollback_failed=false
  trap - ERR EXIT HUP INT TERM
  if [[ "${ROLLED_BACK}" == true ]]; then
    cleanup
    exit "${exit_code}"
  fi
  ROLLED_BACK=true
  if [[ "${SWITCH_STARTED}" == true ]]; then
    echo "Release activation failed; restoring ${ROLE} source and runtime image." >&2
    if ! cp -- "${ENV_BACKUP}" "${ENV_FILE}"; then
      rollback_failed=true
    fi
    if ! restore_source; then
      rollback_failed=true
    fi
    if ! docker_compose up -d --no-build --force-recreate "${SERVICE}" >/dev/null 2>&1; then
      rollback_failed=true
    fi
    if ! bash "${VERIFY_SCRIPT}" >/dev/null 2>&1; then
      rollback_failed=true
    fi
    if [[ "${rollback_failed}" == true ]]; then
      echo "Automatic rollback was incomplete; preserve ${BACKUP} and repair ${ROLE} immediately." >&2
    else
      echo "Automatic rollback restored the previous ${ROLE} release." >&2
    fi
  fi
  cleanup
  exit "${exit_code}"
}

trap 'rollback $?' ERR
trap 'rollback $?' EXIT
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM

validate_manifest
validate_archive
tar -xzf "${ARCHIVE}" -C "${STAGING}"
cp -- "${MANIFEST}" "${NEW_FILES}"
if find "${STAGING}" -type l -print -quit | grep -q .; then
  echo "Release staging contains an unsupported link." >&2
  false
fi
for required in \
  package.json \
  package-lock.json \
  deploy/preproduction-split/Dockerfile \
  "deploy/preproduction-split/${ROLE}.compose.yaml" \
  "deploy/preproduction-split/scripts/verify-${ROLE}.sh"; do
  if [[ ! -f "${STAGING}/${required}" ]]; then
    echo "Release archive is missing ${required}." >&2
    false
  fi
done
for script in "${STAGING}"/deploy/preproduction-split/scripts/*.sh; do
  bash -n "${script}"
done
if [[ ! -s "${ENV_FILE}" ]]; then
  echo "Runtime environment is missing: ${ENV_FILE}" >&2
  false
fi

mirror="$(
  sed -n 's/^AI_EDITOR_DEBIAN_MIRROR=//p' "${ENV_FILE}" |
    tail -n 1
)"
mirror="${mirror:-deb.debian.org}"
sudo docker build \
  --build-arg "DEBIAN_MIRROR=${mirror}" \
  --file "${STAGING}/deploy/preproduction-split/Dockerfile" \
  --tag "${NEW_IMAGE}" \
  "${STAGING}"
sudo docker run --rm --entrypoint node "${NEW_IMAGE}" \
  --check /opt/ai-editor/src/launcher.js
sudo docker run --rm --entrypoint node "${NEW_IMAGE}" \
  --check /opt/ai-editor/gateway/dist/server.js

install -d -m 700 "${BACKUP_ROOT}" "${BACKUP}"
cp -- "${ENV_FILE}" "${ENV_BACKUP}"
cp -- "${ENV_FILE}" "${BACKUP}/runtime.env.before"
if [[ -f "${PREVIOUS_FILES}" ]]; then
  cp -- "${PREVIOUS_FILES}" "${BACKUP}/deployed-files.before"
fi
if [[ -f "${DEPLOY_ROOT}/.deployed-commit" ]]; then
  cp -- "${DEPLOY_ROOT}/.deployed-commit" "${BACKUP}/deployed-commit.before"
fi
: > "${BACKUP_CANDIDATES}"
cat "${MANIFEST}" >> "${BACKUP_CANDIDATES}"
if [[ -f "${PREVIOUS_FILES}" ]]; then
  cat "${PREVIOUS_FILES}" >> "${BACKUP_CANDIDATES}"
fi
LC_ALL=C sort -u "${BACKUP_CANDIDATES}" |
  while IFS= read -r entry; do
    [[ -f "${DEPLOY_ROOT}/${entry}" || -L "${DEPLOY_ROOT}/${entry}" ]] &&
      printf '%s\n' "${entry}"
  done > "${BACKUP_FILES}"
tar -czf "${SOURCE_BACKUP}" -C "${DEPLOY_ROOT}" -T "${BACKUP_FILES}"
cp -- "${SOURCE_BACKUP}" "${BACKUP}/source-before.tar.gz"

SWITCH_STARTED=true
if [[ -f "${PREVIOUS_FILES}" ]]; then
  while IFS= read -r entry || [[ -n "${entry}" ]]; do
    [[ -n "${entry}" ]] || continue
    if ! grep -Fxq "${entry}" "${MANIFEST}"; then
      rm -f -- "${DEPLOY_ROOT}/${entry}"
    fi
  done < "${PREVIOUS_FILES}"
fi
tar -xzf "${ARCHIVE}" -C "${DEPLOY_ROOT}"
cp -- "${MANIFEST}" "${PREVIOUS_FILES}"
printf '%s\n' "${COMMIT}" > "${DEPLOY_ROOT}/.deployed-commit"
set_env AI_EDITOR_RUNTIME_IMAGE "${NEW_IMAGE}"

docker_compose up -d --no-build --force-recreate "${SERVICE}"
if [[ "${FAILPOINT}" == after-activate-before-verify ]]; then
  echo "Requested deployment failpoint reached." >&2
  false
fi
bash "${VERIFY_SCRIPT}"

cp -- "${ENV_FILE}" "${BACKUP}/runtime.env.after"
printf '%s\n' "${COMMIT}" > "${BACKUP}/activated-commit"
chmod 600 "${BACKUP}"/*
SWITCH_STARTED=false
trap - ERR EXIT HUP INT TERM
cleanup

printf '{"status":"PASS","role":"%s","commit":"%s","image":"%s","backup":"%s"}\n' \
  "${ROLE}" "${COMMIT}" "${NEW_IMAGE}" "${BACKUP}"

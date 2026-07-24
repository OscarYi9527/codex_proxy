#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT="$(
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
  pwd -P
)"
EXIT_FILE="${RUN_ROOT}/exit-code"
EXIT_TEMP="${RUN_ROOT}/exit-code.tmp"
PID_FILE="${RUN_ROOT}/launcher.pid"
INSTALL_LOG="${RUN_ROOT}/install.log"

if [[ "${1:-}" == --status ]]; then
  if [[ -s "${EXIT_FILE}" ]]; then
    code="$(cat "${EXIT_FILE}")"
    if [[ "${code}" =~ ^[0-9]+$ ]]; then
      printf 'DONE:%s\n' "${code}"
    else
      printf 'LOST\n'
    fi
  elif [[ -s "${PID_FILE}" ]] &&
    kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
    printf 'RUNNING\n'
  else
    printf 'LOST\n'
  fi
  exit 0
fi

: > "${INSTALL_LOG}"
chmod 600 "${INSTALL_LOG}"
rm -f -- "${EXIT_FILE}" "${EXIT_TEMP}"

finish() {
  local exit_code="${1:-$?}"
  trap - EXIT HUP INT TERM
  printf '%s\n' "${exit_code}" > "${EXIT_TEMP}"
  chmod 600 "${EXIT_TEMP}"
  mv -f -- "${EXIT_TEMP}" "${EXIT_FILE}"
  exit "${exit_code}"
}

trap 'finish $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$#" -ne 5 ]]; then
  echo "Usage: run-release.sh <installer> <gateway|worker> <archive> <manifest> <commit>" \
    >> "${INSTALL_LOG}"
  false
fi

INSTALLER="$1"
ROLE="$2"
ARCHIVE="$3"
MANIFEST="$4"
COMMIT="$5"

for input in "${INSTALLER}" "${ARCHIVE}" "${MANIFEST}"; do
  if [[ ! -f "${input}" || -L "${input}" ]]; then
    echo "Release runner input is missing or unsafe." >> "${INSTALL_LOG}"
    false
  fi
  resolved="$(readlink -f -- "${input}")"
  if [[ "$(dirname -- "${resolved}")" != "${RUN_ROOT}" ]]; then
    echo "Release runner input escaped its private staging directory." >> "${INSTALL_LOG}"
    false
  fi
done

set +e
bash "${INSTALLER}" "${ROLE}" "${ARCHIVE}" "${MANIFEST}" "${COMMIT}" \
  > "${INSTALL_LOG}" 2>&1
result=$?
set -e
exit "${result}"

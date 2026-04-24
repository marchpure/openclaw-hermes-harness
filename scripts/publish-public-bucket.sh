#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/openclaw-plugin-hermes"

PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
UPLOAD_BASE_URL="${UPLOAD_BASE_URL:-${PUBLIC_BUCKET_BASE_URL}}"

INSTALL_SCRIPT_NAME="${INSTALL_SCRIPT_NAME:-install-v2.sh}"
BASE_INSTALL_SCRIPT_NAME="${BASE_INSTALL_SCRIPT_NAME:-hermes-install.sh}"
UNINSTALL_SCRIPT_NAME="${UNINSTALL_SCRIPT_NAME:-uninstall-v2.sh}"
BASE_UNINSTALL_SCRIPT_NAME="${BASE_UNINSTALL_SCRIPT_NAME:-hermes-uninstall.sh}"
PLUGIN_ARCHIVE_NAME="${PLUGIN_ARCHIVE_NAME:-openclaw-plugin-hermes.tar.gz}"

if [[ -t 1 ]]; then
    RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' NC=''
fi

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
log_line() {
    local level="$1" color="$2"
    shift 2
    printf '%b%s [%s]%b %s\n' "${color}" "$(timestamp)" "${level}" "${NC}" "$*"
}
log_info()  { log_line "INFO" "${GREEN}" "$*"; }
log_warn()  { log_line "WARN" "${YELLOW}" "$*"; }
log_error() { log_line "ERROR" "${RED}" "$*"; }
die()       { log_error "$@"; exit 1; }

TEMP_DIRS=()
cleanup_temp() {
    local path=""
    for path in "${TEMP_DIRS[@]:-}"; do
        rm -rf "${path}" 2>/dev/null || true
    done
}
trap cleanup_temp EXIT

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"
}

upload_file() {
    local file="$1" dest_name="$2"
    local dest_url="${UPLOAD_BASE_URL%/}/${dest_name}"
    log_info "上传 ${file} -> ${dest_url}"
    curl --fail --silent --show-error -T "${file}" "${dest_url}"
}

build_plugin_archive() {
    require_cmd npm
    require_cmd python3

    local tmp_dir pack_output packed_name packed_tar output_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")

    pack_output="$(cd "${PLUGIN_DIR}" && npm pack --pack-destination "${tmp_dir}" --json)"
    packed_name="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[0]["filename"])' <<<"${pack_output}")"
    packed_tar="${tmp_dir}/${packed_name}"
    output_tar="${tmp_dir}/${PLUGIN_ARCHIVE_NAME}"
    cp "${packed_tar}" "${output_tar}"
    printf '%s\n' "${output_tar}"
}

main() {
    require_cmd curl
    [[ -f "${SCRIPT_DIR}/${INSTALL_SCRIPT_NAME}" ]] || die "缺少安装脚本: ${SCRIPT_DIR}/${INSTALL_SCRIPT_NAME}"
    [[ -f "${SCRIPT_DIR}/${BASE_INSTALL_SCRIPT_NAME}" ]] || die "缺少基础安装脚本: ${SCRIPT_DIR}/${BASE_INSTALL_SCRIPT_NAME}"
    [[ -f "${SCRIPT_DIR}/${UNINSTALL_SCRIPT_NAME}" ]] || die "缺少卸载脚本: ${SCRIPT_DIR}/${UNINSTALL_SCRIPT_NAME}"
    [[ -f "${SCRIPT_DIR}/${BASE_UNINSTALL_SCRIPT_NAME}" ]] || die "缺少基础卸载脚本: ${SCRIPT_DIR}/${BASE_UNINSTALL_SCRIPT_NAME}"
    [[ -d "${PLUGIN_DIR}" ]] || die "缺少插件目录: ${PLUGIN_DIR}"

    local plugin_archive
    plugin_archive="$(build_plugin_archive)"
    log_info "插件包已生成: ${plugin_archive} ($(wc -c < "${plugin_archive}") bytes)"

    upload_file "${SCRIPT_DIR}/${INSTALL_SCRIPT_NAME}" "${INSTALL_SCRIPT_NAME}"
    upload_file "${SCRIPT_DIR}/${BASE_INSTALL_SCRIPT_NAME}" "${BASE_INSTALL_SCRIPT_NAME}"
    upload_file "${SCRIPT_DIR}/${UNINSTALL_SCRIPT_NAME}" "${UNINSTALL_SCRIPT_NAME}"
    upload_file "${SCRIPT_DIR}/${BASE_UNINSTALL_SCRIPT_NAME}" "${BASE_UNINSTALL_SCRIPT_NAME}"
    upload_file "${plugin_archive}" "${PLUGIN_ARCHIVE_NAME}"

    log_info "发布完成"
    log_info "安装命令: curl -fsSL ${PUBLIC_BUCKET_BASE_URL%/}/${INSTALL_SCRIPT_NAME} | bash"
}

main "$@"

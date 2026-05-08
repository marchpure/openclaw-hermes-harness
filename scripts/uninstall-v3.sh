#!/usr/bin/env bash
# Hermes Harness Runtime v3 卸载脚本
# 支持本地执行和 curl | bash

set -Eeuo pipefail

PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
BASE_UNINSTALL_URL="${BASE_UNINSTALL_URL:-${PUBLIC_BUCKET_BASE_URL}/hermes-uninstall.sh}"

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
if [[ -n "${SCRIPT_SOURCE}" && -e "${SCRIPT_SOURCE}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
else
    SCRIPT_DIR=""
fi
BASE_UNINSTALL_SCRIPT="${SCRIPT_DIR:+${SCRIPT_DIR}/hermes-uninstall.sh}"

PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"

if [[ -t 1 ]]; then
    RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' NC=''
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

download_file() {
    local url="$1" dest="$2"
    curl -fsSL "${url}" -o "${dest}"
}

resolve_base_uninstall_script() {
    if [[ -n "${BASE_UNINSTALL_SCRIPT}" && -f "${BASE_UNINSTALL_SCRIPT}" ]]; then
        printf '%s\n' "${BASE_UNINSTALL_SCRIPT}"
        return 0
    fi

    command -v curl >/dev/null 2>&1 || die "缺少 curl，无法下载基础卸载脚本"
    local tmp_dir script_path
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    script_path="${tmp_dir}/hermes-uninstall.sh"
    download_file "${BASE_UNINSTALL_URL}" "${script_path}"
    chmod +x "${script_path}"
    printf '%s\n' "${script_path}"
}

cleanup_runtime_entries() {
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    log_info "清理 Hermes runtime provider/alias 配置"

    if command -v jq >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp)"
        jq \
          --arg pk "${PLUGIN_CONFIG_KEY}" \
          --arg legacy_pk "hermes" \
          '
          del(.plugins.entries[$pk])
          | del(.plugins.entries[$legacy_pk])
          | .plugins.allow = ((.plugins.allow // []) | map(select(. != $pk and . != $legacy_pk)))
          | del(.models.providers.hermes)
          | del(.agents.defaults.models["hermes/default"])
          | del(.agents.defaults.models["hermes"])
          ' "${OPENCLAW_CONFIG}" > "${tmp}" && mv "${tmp}" "${OPENCLAW_CONFIG}"
    elif command -v python3 >/dev/null 2>&1; then
        python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" <<'PYEOF'
import json, sys
cf, pk = sys.argv[1], sys.argv[2]
with open(cf) as f:
    data = json.load(f)
data.get("plugins", {}).get("entries", {}).pop(pk, None)
data.get("plugins", {}).get("entries", {}).pop("hermes", None)
data.get("models", {}).get("providers", {}).pop("hermes", None)
aliases = data.get("agents", {}).get("defaults", {}).get("models", {})
aliases.pop("hermes/default", None)
aliases.pop("hermes", None)
allow = data.get("plugins", {}).get("allow", [])
data.setdefault("plugins", {})["allow"] = [item for item in allow if item not in (pk, "hermes")]
with open(cf, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
    else
        die "缺少 jq 或 python3，无法清理 OpenClaw 配置"
    fi
}

cleanup_plugin_dirs() {
    local dir=""
    for dir in "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}" "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}"; do
        if [[ -e "${dir}" ]]; then
            rm -rf "${dir}"
            log_info "已补充删除插件目录: ${dir}"
        fi
    done
}

main() {
    local base_uninstall_script
    base_uninstall_script="$(resolve_base_uninstall_script)"

    bash "${base_uninstall_script}" "$@"
    cleanup_runtime_entries
    cleanup_plugin_dirs
    log_info "uninstall-v3 执行完成"
}

main "$@"

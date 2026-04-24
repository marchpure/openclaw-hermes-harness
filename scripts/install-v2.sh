#!/usr/bin/env bash
# Hermes Harness Runtime v2 安装/升级脚本
# 支持:
# 1. 本地仓库执行: bash scripts/install-v2.sh
# 2. 远端直执行: curl -fsSL .../install-v2.sh | bash
# 3. Fresh install / legacy upgrade 均可

set -Eeuo pipefail

PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
BASE_INSTALL_URL="${BASE_INSTALL_URL:-${PUBLIC_BUCKET_BASE_URL}/hermes-install.sh}"
PUBLIC_PLUGIN_URL="${PUBLIC_PLUGIN_URL:-${PUBLIC_BUCKET_BASE_URL}/openclaw-plugin-hermes.tar.gz}"

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
if [[ -n "${SCRIPT_SOURCE}" && -e "${SCRIPT_SOURCE}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
    REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
    SCRIPT_DIR=""
    REPO_ROOT=""
fi

BASE_INSTALL_SCRIPT="${SCRIPT_DIR:+${SCRIPT_DIR}/hermes-install.sh}"
LOCAL_PLUGIN_DIR="${REPO_ROOT:+${REPO_ROOT}/openclaw-plugin-hermes}"

MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION:-2026.4.15}"
DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR:-/var/cache/hermes-agent}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"

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

check_prereqs() {
    command -v curl >/dev/null 2>&1 || die "缺少 curl，无法下载基础脚本或插件包"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" ]]; then
        command -v tar >/dev/null 2>&1 || die "缺少 tar，无法打包本地插件"
    fi
}

resolve_base_install_script() {
    if [[ -n "${BASE_INSTALL_SCRIPT}" && -f "${BASE_INSTALL_SCRIPT}" ]]; then
        printf '%s\n' "${BASE_INSTALL_SCRIPT}"
        return 0
    fi

    local tmp_dir plugin_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    plugin_tar="${tmp_dir}/hermes-install.sh"
    download_file "${BASE_INSTALL_URL}" "${plugin_tar}"
    chmod +x "${plugin_tar}"
    printf '%s\n' "${plugin_tar}"
}

resolve_plugin_tarball() {
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
        command -v npm >/dev/null 2>&1 || die "缺少 npm，无法打包本地插件"
        local tmp_dir pack_output plugin_tar
        tmp_dir="$(mktemp -d)"
        TEMP_DIRS+=("${tmp_dir}")
        pack_output="$(cd "${LOCAL_PLUGIN_DIR}" && npm pack --pack-destination "${tmp_dir}" --json)"
        plugin_tar="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[0]["filename"])' <<<"${pack_output}")"
        plugin_tar="${tmp_dir}/${plugin_tar}"
        printf '%s\n' "${plugin_tar}"
        return 0
    fi

    local tmp_dir plugin_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    plugin_tar="${tmp_dir}/openclaw-plugin-hermes.tar.gz"
    download_file "${PUBLIC_PLUGIN_URL}" "${plugin_tar}"
    printf '%s\n' "${plugin_tar}"
}

detect_existing_installation() {
    local found=false
    if [[ -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}" || -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}" ]]; then
        found=true
    fi

    if [[ -f "${OPENCLAW_CONFIG}" ]]; then
        if command -v jq >/dev/null 2>&1; then
            if jq -e --arg pk "${PLUGIN_CONFIG_KEY}" '.plugins.entries[$pk] != null or .models.providers.hermes != null or .agents.defaults.models["hermes/default"] != null' "${OPENCLAW_CONFIG}" >/dev/null 2>&1; then
                found=true
            fi
        elif command -v python3 >/dev/null 2>&1; then
            if python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" >/dev/null 2>&1 <<'PYEOF'
import json, sys
cfg, pk = sys.argv[1], sys.argv[2]
with open(cfg) as f:
    data = json.load(f)
plugins = data.get("plugins", {}).get("entries", {})
providers = data.get("models", {}).get("providers", {})
aliases = data.get("agents", {}).get("defaults", {}).get("models", {})
if plugins.get(pk) is not None or providers.get("hermes") is not None or aliases.get("hermes/default") is not None:
    sys.exit(0)
sys.exit(1)
PYEOF
            then
                found=true
            fi
        fi
    fi

    if [[ "${found}" == true ]]; then
        log_info "检测到已有 Hermes 安装痕迹，本次按升级流程执行"
    else
        log_info "未检测到 Hermes 安装痕迹，本次按全新安装流程执行"
    fi
}

normalize_runtime_entries() {
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    log_info "补齐 Hermes runtime 配置归一化"

    if command -v jq >/dev/null 2>&1; then
        local tmp default_model
        tmp="$(mktemp)"
        TEMP_DIRS+=("${tmp}")
        default_model="$(jq -r --arg pk "${PLUGIN_CONFIG_KEY}" '.plugins.entries[$pk].config.defaultModel // "doubao-seed-2-0-pro-260215"' "${OPENCLAW_CONFIG}" 2>/dev/null)"

        jq \
          --arg pk "${PLUGIN_CONFIG_KEY}" \
          --arg legacy_pk "hermes" \
          --arg cn "${CONTAINER_NAME:-hermes-agent}" \
          --arg dm "${default_model:-doubao-seed-2-0-pro-260215}" \
          '
          del(.plugins.entries[$legacy_pk])
          | .plugins.allow = (((.plugins.allow // []) | map(select(. != $legacy_pk))) + [$pk] | unique)
          | .plugins.entries[$pk] = (.plugins.entries[$pk] // {})
          | .plugins.entries[$pk].enabled = true
          | .plugins.entries[$pk].config = ((.plugins.entries[$pk].config // {}) + {
              "hermesContainerName": $cn,
              "defaultModel": $dm,
              "autoStrategy": true,
              "enableLayeredProtocol": false,
              "timeout": 600
            })
          | .agents.defaults.models = ((.agents.defaults.models // {}) + {
              "hermes/default": { "alias": "hermes" }
            })
          | .models.providers.hermes = {
              "baseUrl": "http://127.0.0.1/hermes-runtime",
              "apiKey": "hermes-runtime",
              "auth": "token",
              "api": "openai-responses",
              "models": [
                {
                  "id": "default",
                  "name": "default",
                  "reasoning": true,
                  "input": ["text", "image"],
                  "contextWindow": 200000,
                  "maxTokens": 32000
                }
              ]
            }
          ' "${OPENCLAW_CONFIG}" > "${tmp}" && mv "${tmp}" "${OPENCLAW_CONFIG}"
    elif command -v python3 >/dev/null 2>&1; then
        python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" "${CONTAINER_NAME:-hermes-agent}" <<'PYEOF'
import json, sys
cf, pk, cn = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cf) as f:
    data = json.load(f)
plugins = data.setdefault("plugins", {}).setdefault("entries", {})
plugins.pop("hermes", None)
entry = plugins.setdefault(pk, {})
entry["enabled"] = True
cfg = entry.setdefault("config", {})
cfg.setdefault("defaultModel", "doubao-seed-2-0-pro-260215")
cfg.update({
    "hermesContainerName": cn,
    "defaultModel": cfg.get("defaultModel", "doubao-seed-2-0-pro-260215"),
    "autoStrategy": True,
    "enableLayeredProtocol": False,
    "timeout": 600,
})
data.setdefault("agents", {}).setdefault("defaults", {}).setdefault("models", {})["hermes/default"] = {"alias": "hermes"}
data.setdefault("models", {}).setdefault("providers", {})["hermes"] = {
    "baseUrl": "http://127.0.0.1/hermes-runtime",
    "apiKey": "hermes-runtime",
    "auth": "token",
    "api": "openai-responses",
    "models": [
        {
            "id": "default",
            "name": "default",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 32000,
        }
    ],
}
allow = data.setdefault("plugins", {}).setdefault("allow", [])
allow = [item for item in allow if item != "hermes"]
if pk not in allow:
    allow.append(pk)
data["plugins"]["allow"] = allow
with open(cf, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
    else
        die "缺少 jq 或 python3，无法归一化 OpenClaw 配置"
    fi
}

invalidate_cached_plugin_archive() {
    local cached_plugin_tar="${DOWNLOAD_CACHE_DIR}/hermes-plugin.tar.gz"
    if [[ -f "${cached_plugin_tar}" ]]; then
        rm -f "${cached_plugin_tar}"
        log_info "已清理旧插件缓存，强制重新下载: ${cached_plugin_tar}"
    else
        log_info "未发现旧插件缓存: ${cached_plugin_tar}"
    fi
}

main() {
    check_prereqs
    detect_existing_installation

    local base_install_script
    base_install_script="$(resolve_base_install_script)"

    local plugin_tar
    plugin_tar="$(resolve_plugin_tarball)"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
        log_info "使用当前仓库插件源码打包安装: ${plugin_tar}"
    else
        log_info "使用公共桶插件包安装: ${plugin_tar}"
    fi
    log_info "要求 OpenClaw 版本 >= ${MIN_OPENCLAW_VERSION}"

    # 旧版 install-v2 可能把错误插件包缓存到固定路径
    # /var/cache/hermes-agent/hermes-plugin.tar.gz。这里只失效插件缓存，
    # 不动大镜像缓存，避免每次都重新加载 1.1G 镜像。
    invalidate_cached_plugin_archive

    MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION}" \
    DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR}" \
    TOS_PLUGIN_URL="file://${plugin_tar}" \
    bash "${base_install_script}" "$@"

    normalize_runtime_entries
    log_info "install-v2 执行完成"
}

main "$@"

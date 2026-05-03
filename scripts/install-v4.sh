#!/usr/bin/env bash
# Hermes Harness Runtime v4 安装/升级脚本
# 支持:
# 1. 本地仓库执行: bash scripts/install-v4.sh
# 2. 远端直执行: curl -fsSL .../install-v4.sh | bash
# 3. Fresh install / legacy upgrade 均可
#
# v4 变更:
# - 使用镜像仓库引用直接启动最新 Hermes 镜像，而不是下载 TOS tar 后 docker load。
# - 容器使用 host network，并显式设置 ACP_TCP_HOST=127.0.0.1、ACP_TCP_PORT=3100。
# - 默认启用 layered protocol 和 OpenClaw host-backed skill/MCP 路由。

set -Eeuo pipefail

PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
BASE_INSTALL_URL="${BASE_INSTALL_URL:-${PUBLIC_BUCKET_BASE_URL}/hermes-install.sh}"
PUBLIC_PLUGIN_URL="${PUBLIC_PLUGIN_URL:-${PUBLIC_BUCKET_BASE_URL}/openclaw-plugin-hermes-install-v3.tgz}"

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

HERMES_IMAGE_REF="${HERMES_IMAGE_REF:-iaas-test01-cn-beijing.cr.volces.com/hermes/hermes-dockerimage:v1.2.0}"
HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"
CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}"
ACP_TCP_PORT="${ACP_TCP_PORT:-3100}"
ACP_PORT="${ACP_PORT:-${ACP_TCP_PORT}}"

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
    command -v python3 >/dev/null 2>&1 || die "缺少 python3，无法生成 v4 patched installer"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" ]]; then
        command -v tar >/dev/null 2>&1 || die "缺少 tar，无法打包本地插件"
        command -v npm >/dev/null 2>&1 || die "缺少 npm，无法打包本地插件"
    fi
}

resolve_base_install_script() {
    if [[ -n "${BASE_INSTALL_SCRIPT}" && -f "${BASE_INSTALL_SCRIPT}" ]]; then
        printf '%s\n' "${BASE_INSTALL_SCRIPT}"
        return 0
    fi

    local tmp_dir installer_path
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    installer_path="${tmp_dir}/hermes-install.sh"
    download_file "${BASE_INSTALL_URL}" "${installer_path}"
    chmod +x "${installer_path}"
    printf '%s\n' "${installer_path}"
}

resolve_plugin_tarball() {
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
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
    plugin_tar="${tmp_dir}/openclaw-plugin-hermes-install-v3.tgz"
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

create_v4_base_installer() {
    local source_script="$1"
    local tmp_dir patched_script
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    patched_script="${tmp_dir}/hermes-install-v4-patched.sh"

    HERMES_IMAGE_REF="${HERMES_IMAGE_REF}" \
    ACP_TCP_HOST="${ACP_TCP_HOST}" \
    ACP_TCP_PORT="${ACP_TCP_PORT}" \
    python3 - "${source_script}" "${patched_script}" <<'PYEOF'
import os
import re
import sys
from pathlib import Path

src, dst = map(Path, sys.argv[1:3])
text = src.read_text()
image_ref = os.environ["HERMES_IMAGE_REF"]
tcp_host = os.environ["ACP_TCP_HOST"]
tcp_port = os.environ["ACP_TCP_PORT"]

text = text.replace(
    'TOS_IMAGE_URL="${TOS_IMAGE_URL:-https://scarif-${HERMES_REGION}.tos-${HERMES_REGION}.ivolces.com/arkclaw/hermes/hermes-image/hermes-agent-image.tar.gz}"',
    f'TOS_IMAGE_URL="${{TOS_IMAGE_URL:-}}"\nHERMES_IMAGE_REF="${{HERMES_IMAGE_REF:-{image_ref}}}"',
)
text = text.replace(
    'HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"',
    'HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-${HERMES_IMAGE_REF}}"',
)
text = text.replace(
    'local oc_model_candidate="${OC_PRIMARY_MODEL:-${OC_DEFAULT_MODEL}}"',
    'local oc_model_candidate="${OC_DEFAULT_MODEL}"',
)
text = text.replace(
    'choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "${OC_PROVIDER:-}" "ark" API_PROVIDER provider_source',
    'choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "${OC_PROVIDER:+custom}" "custom" API_PROVIDER provider_source',
)
text = text.replace('ACP_PORT="${ACP_PORT:-3100}"', f'ACP_PORT="${{ACP_PORT:-{tcp_port}}}"')
text = text.replace('echo "ACP_TCP_PORT=3100"', 'echo "ACP_TCP_PORT=${ACP_PORT}"')
text = text.replace('echo "ACP_TCP_HOST=0.0.0.0"', f'echo "ACP_TCP_HOST=${{ACP_TCP_HOST:-{tcp_host}}}"')
text = text.replace(
    '''    if [[ -n "${API_BASE_URL}" ]]; then
        sed -i "s|^\\(\\s*base_url:\\s*\\).*|\\1\\"${API_BASE_URL}\\"|" "${config_yaml}"
    fi
    log_info "config.yaml 已更新 (model=${DEFAULT_MODEL_VAL}, base_url=${API_BASE_URL:-默认})"''',
    '''    if [[ -n "${API_PROVIDER}" ]]; then
        sed -i "s|^\\(\\s*provider:\\s*\\).*|\\1\\"${API_PROVIDER}\\"|" "${config_yaml}"
    fi
    if [[ -n "${API_BASE_URL}" ]]; then
        sed -i "s|^\\(\\s*base_url:\\s*\\).*|\\1\\"${API_BASE_URL}\\"|" "${config_yaml}"
    fi
    log_info "config.yaml 已更新 (provider=${API_PROVIDER}, model=${DEFAULT_MODEL_VAL}, base_url=${API_BASE_URL:-默认})"''',
)
text = text.replace(
    '''provider_to_base_url_env() {
    case "$1" in
        openai)         echo "OPENAI_BASE_URL" ;;
        minimax)        echo "MINIMAX_BASE_URL" ;;
        openrouter)     echo "OPENROUTER_BASE_URL" ;;
        volcengine|ark) echo "ARK_BASE_URL" ;;
        *)              echo "" ;;
    esac
}''',
    '''provider_to_base_url_env() {
    case "$1" in
        openai|custom)  echo "OPENAI_BASE_URL" ;;
        minimax)        echo "MINIMAX_BASE_URL" ;;
        openrouter)     echo "OPENROUTER_BASE_URL" ;;
        volcengine|ark) echo "ARK_BASE_URL" ;;
        *)              echo "" ;;
    esac
}''',
)
text = text.replace(
    '''phase2_pull_image() {
    log_step "拉取 Hermes 镜像"

    local current_image_id=""
    if image_exists "${HERMES_IMAGE_NAME}:latest"; then
        current_image_id="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_NAME}:latest")"
        log_info "当前镜像 ID: ${current_image_id}"
    else
        log_info "当前不存在 ${HERMES_IMAGE_NAME}:latest，将导入新镜像"
    fi

    local image_file="${CACHE_DIR}/hermes-agent-image.tar.gz"

    log_info "下载镜像: ${TOS_IMAGE_URL}"
    download_file "${TOS_IMAGE_URL}" "${image_file}"

    log_info "加载镜像..."
    docker load < "${image_file}"

    if ! image_exists "${HERMES_IMAGE_NAME}:latest"; then
        die "镜像加载后未找到 ${HERMES_IMAGE_NAME}:latest，请检查镜像名"
    fi

    local new_image_id
    new_image_id="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_NAME}:latest")"
    if [[ -n "${current_image_id}" && "${current_image_id}" == "${new_image_id}" ]]; then
        log_info "镜像导入完成，ID 未变化: ${new_image_id}"
    else
        log_info "镜像导入完成，新镜像 ID: ${new_image_id}"
    fi
}''',
    '''phase2_pull_image() {
    log_step "拉取 Hermes 镜像"

    log_info "拉取镜像: ${HERMES_IMAGE_REF}"
    docker pull "${HERMES_IMAGE_REF}"

    if ! image_exists "${HERMES_IMAGE_REF}"; then
        die "镜像拉取后未找到 ${HERMES_IMAGE_REF}"
    fi

    local image_id
    image_id="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_REF}")"
    log_info "镜像就绪: ${HERMES_IMAGE_REF} (${image_id})"

    docker tag "${HERMES_IMAGE_REF}" "${HERMES_IMAGE_NAME}:latest"
    log_info "已标记本地镜像: ${HERMES_IMAGE_NAME}:latest -> ${HERMES_IMAGE_REF}"
}''',
)
text = text.replace(
    '''    docker run -d \\
        --name "${CONTAINER_NAME}" \\
        --init \\
        --restart unless-stopped \\
        --user root \\
        -e TZ=Asia/Shanghai \\
        --env-file "${DATA_DIR}/.env" \\
        --entrypoint "/opt/hermes/docker/entrypoint-acp.sh" \\
        --security-opt no-new-privileges=true \\
        --tmpfs /tmp:size=256M \\
        -v "${DATA_DIR}:/opt/data" \\
        -p "127.0.0.1:${ACP_PORT}:3100" \\
        --cpus="${CPU_LIMIT}" \\
        --memory="${MEM_LIMIT}" \\
        --log-driver json-file \\
        --log-opt max-size=20m \\
        --log-opt max-file=5 \\
        "${image_ref}" >/dev/null''',
    '''    docker run -d \\
        --name "${CONTAINER_NAME}" \\
        --init \\
        --restart unless-stopped \\
        --user root \\
        --network host \\
        -e ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}" \\
        -e ACP_TCP_PORT="${ACP_PORT}" \\
        -e TZ=Asia/Shanghai \\
        --env-file "${DATA_DIR}/.env" \\
        --entrypoint "/opt/hermes/docker/entrypoint-acp.sh" \\
        --security-opt no-new-privileges=true \\
        --tmpfs /tmp:size=256M \\
        -v "${DATA_DIR}:/opt/data" \\
        --cpus="${CPU_LIMIT}" \\
        --memory="${MEM_LIMIT}" \\
        --log-driver json-file \\
        --log-opt max-size=20m \\
        --log-opt max-file=5 \\
        "${image_ref}" >/dev/null''',
)
text = text.replace(
    '''               "autoStrategy": true,
               "enableLayeredProtocol": false,
               "timeout": 600
           }''',
    '''               "autoStrategy": true,
               "enableLayeredProtocol": true,
               "defaultContextLevel": "L3",
               "runtimeMinContextLevel": "L3",
               "runtimeProjectWorkspaceSkills": true,
               "transport": "tcp",
               "tcpHost": "127.0.0.1",
               "tcpPort": 3100,
               "timeout": 1800,
               "skillProjection": {
                 "hostBackedDenylist": ["browser", "feishu"],
                 "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser-use", "compute-use"],
                 "containerEnvSkillNames": []
               },
               "mcpBridge": {
                 "enabled": true,
                 "servers": {},
                 "env": {}
               }
           }''',
)
text = text.replace(
    '''    'autoStrategy': True,
    'enableLayeredProtocol': False,
    'timeout': 600
}''',
    '''    'autoStrategy': True,
    'enableLayeredProtocol': True,
    'defaultContextLevel': 'L3',
    'runtimeMinContextLevel': 'L3',
    'runtimeProjectWorkspaceSkills': True,
    'transport': 'tcp',
    'tcpHost': '127.0.0.1',
    'tcpPort': 3100,
    'timeout': 1800,
    'skillProjection': {
        'hostBackedDenylist': ['browser', 'feishu'],
        'hostBackedSkillNames': ['lark-doc', 'lark-calendar', 'lark-im', 'lark-sheets', 'lark-base', 'lark-drive', 'lark-task', 'lark-mail', 'feishu', 'browser-use', 'compute-use'],
        'containerEnvSkillNames': [],
    },
    'mcpBridge': {
        'enabled': True,
        'servers': {},
        'env': {},
    }
}''',
)

dst.write_text(text)
dst.chmod(0o755)
PYEOF

    printf '%s\n' "${patched_script}"
}

normalize_runtime_entries() {
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    log_info "补齐 Hermes runtime v4 配置归一化"

    if command -v jq >/dev/null 2>&1; then
        local tmp default_model
        tmp="$(mktemp)"
        TEMP_DIRS+=("${tmp}")
        default_model="$(jq -r --arg pk "${PLUGIN_CONFIG_KEY}" '.plugins.entries[$pk].config.defaultModel // "doubao-seed-2-0-pro-260215"' "${OPENCLAW_CONFIG}" 2>/dev/null)"

        jq \
          --arg pk "${PLUGIN_CONFIG_KEY}" \
          --arg legacy_pk "hermes" \
          --arg cn "${CONTAINER_NAME}" \
          --arg dm "${default_model:-doubao-seed-2-0-pro-260215}" \
          --arg tcp_host "${ACP_TCP_HOST}" \
          --argjson tcp_port "${ACP_TCP_PORT}" \
          '
          del(.plugins.entries[$legacy_pk])
          | .plugins.allow = (((.plugins.allow // []) | map(select(. != $legacy_pk))) + [$pk] | unique)
          | .plugins.entries[$pk] = (.plugins.entries[$pk] // {})
          | .plugins.entries[$pk].enabled = true
          | .plugins.entries[$pk].config = ((.plugins.entries[$pk].config // {}) + {
              "hermesContainerName": $cn,
              "defaultModel": $dm,
              "autoStrategy": true,
              "enableLayeredProtocol": true,
              "defaultContextLevel": "L3",
              "runtimeMinContextLevel": "L3",
              "runtimeProjectWorkspaceSkills": true,
              "transport": "tcp",
              "tcpHost": $tcp_host,
              "tcpPort": $tcp_port,
              "timeout": 1800,
              "skillProjection": {
                "hostBackedDenylist": ["browser", "feishu"],
                "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser-use", "compute-use"],
                "containerEnvSkillNames": []
              },
              "mcpBridge": {
                "enabled": true,
                "servers": {},
                "env": {}
              }
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
        python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" "${CONTAINER_NAME}" "${ACP_TCP_HOST}" "${ACP_TCP_PORT}" <<'PYEOF'
import json, sys
cf, pk, cn, tcp_host, tcp_port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
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
    "autoStrategy": True,
    "enableLayeredProtocol": True,
    "defaultContextLevel": "L3",
    "runtimeMinContextLevel": "L3",
    "runtimeProjectWorkspaceSkills": True,
    "transport": "tcp",
    "tcpHost": tcp_host,
    "tcpPort": tcp_port,
    "timeout": 1800,
    "skillProjection": {
        "hostBackedDenylist": ["browser", "feishu"],
        "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser-use", "compute-use"],
        "containerEnvSkillNames": [],
    },
    "mcpBridge": {
        "enabled": True,
        "servers": {},
        "env": {},
    },
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

patch_openclaw_runtime_for_hermes_toolset() {
    local dist_dir="/usr/lib/node_modules/openclaw/dist"
    [[ -d "${dist_dir}" ]] || {
        log_warn "未找到 OpenClaw dist 目录，跳过 Hermes toolset runtime 补丁: ${dist_dir}"
        return 0
    }

    log_info "补齐 Hermes MCP toolset 上下文透传补丁"

    python3 - "${dist_dir}" <<'PYEOF'
import sys
from pathlib import Path

dist = Path(sys.argv[1])

def patch(path: Path, replacements):
    text = path.read_text()
    original = text
    for old, new in replacements:
        if new in text:
            continue
        if old not in text:
            raise SystemExit(f"patch anchor not found in {path}: {old[:120]!r}")
        text = text.replace(old, new, 1)
    if text != original:
        path.write_text(text)

patch(dist / "mcp-http-DkuYmsG-.js", [
    (
'''			"x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
			"x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
			"x-openclaw-sender-id": "${OPENCLAW_MCP_SENDER_ID}",''',
'''			"x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
			"x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
			"x-openclaw-message-to": "${OPENCLAW_MCP_MESSAGE_TO}",
			"x-openclaw-thread-id": "${OPENCLAW_MCP_THREAD_ID}",
			"x-openclaw-current-message-id": "${OPENCLAW_MCP_CURRENT_MESSAGE_ID}",
			"x-openclaw-sender-id": "${OPENCLAW_MCP_SENDER_ID}",'''
    ),
    (
'''		messageProvider: normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? void 0,
		accountId: normalizeOptionalString(getHeader(req, "x-openclaw-account-id")),
		senderId: normalizeOptionalString(getHeader(req, "x-openclaw-sender-id")),''',
'''		messageProvider: normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel")) ?? void 0,
		accountId: normalizeOptionalString(getHeader(req, "x-openclaw-account-id")),
		agentTo: normalizeOptionalString(getHeader(req, "x-openclaw-message-to")),
		agentThreadId: normalizeOptionalString(getHeader(req, "x-openclaw-thread-id")),
		currentMessageId: normalizeOptionalString(getHeader(req, "x-openclaw-current-message-id")),
		senderId: normalizeOptionalString(getHeader(req, "x-openclaw-sender-id")),'''
    ),
    (
'''			params.accountId ?? "",
			params.senderId ?? "",''',
'''			params.accountId ?? "",
			params.agentTo ?? "",
			params.agentThreadId ?? "",
			params.currentMessageId ?? "",
			params.senderId ?? "",'''
    ),
    (
'''			accountId: params.accountId,
			senderId: params.senderId,''',
'''			accountId: params.accountId,
			agentTo: params.agentTo,
			agentThreadId: params.agentThreadId,
			currentMessageId: params.currentMessageId,
			senderId: params.senderId,'''
    ),
    (
'''					accountId: requestContext.accountId,
					senderIsOwner: requestContext.senderIsOwner''',
'''					accountId: requestContext.accountId,
					agentTo: requestContext.agentTo,
					agentThreadId: requestContext.agentThreadId,
					currentMessageId: requestContext.currentMessageId,
					senderId: requestContext.senderId,
					senderIsOwner: requestContext.senderIsOwner'''
    ),
])

patch(dist / "tools-invoke-http-BXZP_ZuH.js", [
    (
'''	const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
	const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));''',
'''	const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
	const senderId = normalizeOptionalString(getHeader(req, "x-openclaw-sender-id"));
	const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));'''
    ),
    (
'''		accountId,
		agentTo,''',
'''		accountId,
		senderId,
		agentTo,'''
    ),
])

patch(dist / "tool-resolution-8Rm8yrsK.js", [
    (
'''			agentAccountId: params.accountId,
			agentTo: params.agentTo,''',
'''			agentAccountId: params.accountId,
			requesterSenderId: params.senderId,
			agentTo: params.agentTo,'''
    ),
    (
'''			agentThreadId: params.agentThreadId,
			allowGatewaySubagentBinding:''',
'''			agentThreadId: params.agentThreadId,
			currentMessageId: params.currentMessageId,
			allowGatewaySubagentBinding:'''
    ),
])

patch(dist / "openclaw-tools-CUmYpN1l.js", [
    (
'''			messageChannel: options?.agentChannel,
			agentAccountId: options?.agentAccountId,
			deliveryContext,''',
'''			messageChannel: options?.agentChannel,
			agentAccountId: options?.agentAccountId,
			currentMessageId: options?.currentMessageId != null ? String(options.currentMessageId) : void 0,
			deliveryContext,'''
    ),
])

patch(dist / "loader-DYW2PvbF.js", [
    (
'''import { createHash } from "node:crypto";''',
'''import { createHash } from "node:crypto";
import { createRequire } from "node:module";'''
    ),
    (
'''		const optional = opts?.optional === true;
		const factory = typeof tool === "function" ? tool : (_ctx) => tool;
		if (typeof tool !== "function") names.push(tool.name);''',
'''		const optional = opts?.optional === true;
		const wrapLarkToolIfNeeded = (resolved, ctx) => {
			if (record.id !== "openclaw-lark" || !resolved || typeof resolved !== "object") return resolved;
			if (typeof resolved.execute !== "function" || !String(resolved.name ?? "").startsWith("feishu_")) return resolved;
			return {
				...resolved,
				async execute(...args) {
					const senderOpenId = typeof ctx?.requesterSenderId === "string" ? ctx.requesterSenderId.trim() : "";
					const accountId = typeof ctx?.agentAccountId === "string" && ctx.agentAccountId.trim() ? ctx.agentAccountId.trim() : "default";
					const chatId = typeof ctx?.deliveryContext?.to === "string" ? ctx.deliveryContext.to.trim() : "";
					if (!senderOpenId) return resolved.execute.apply(this, args);
					try {
						const req = createRequire(path.join(record.rootDir, "index.js"));
						const { getTicket, withTicket } = req("./src/core/lark-ticket.js");
						if (getTicket?.()) return resolved.execute.apply(this, args);
						return await withTicket({
							messageId: ctx?.currentMessageId != null ? String(ctx.currentMessageId) : `tool-driven-${Date.now()}`,
							chatId,
							accountId,
							startTime: Date.now(),
							senderOpenId,
							threadId: ctx?.deliveryContext?.threadId != null ? String(ctx.deliveryContext.threadId) : void 0
						}, () => resolved.execute.apply(this, args));
					} catch {
						return resolved.execute.apply(this, args);
					}
				}
			};
		};
		const factory = typeof tool === "function" ? (ctx) => {
			const resolved = tool(ctx);
			if (Array.isArray(resolved)) return resolved.map((entry) => wrapLarkToolIfNeeded(entry, ctx));
			return wrapLarkToolIfNeeded(resolved, ctx);
		} : (ctx) => wrapLarkToolIfNeeded(tool, ctx);
		if (typeof tool !== "function") names.push(tool.name);'''
    ),
])
PYEOF
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

    local patched_install_script
    patched_install_script="$(create_v4_base_installer "${base_install_script}")"

    local plugin_tar
    plugin_tar="$(resolve_plugin_tarball)"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
        log_info "使用当前仓库插件源码打包安装: ${plugin_tar}"
    else
        log_info "使用公共桶插件包安装: ${plugin_tar}"
    fi
    log_info "要求 OpenClaw 版本 >= ${MIN_OPENCLAW_VERSION}"
    log_info "Hermes v4 镜像: ${HERMES_IMAGE_REF}"
    log_info "Hermes ACP 监听: ${ACP_TCP_HOST}:${ACP_TCP_PORT}"

    invalidate_cached_plugin_archive

    MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION}" \
    DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR}" \
    TOS_PLUGIN_URL="file://${plugin_tar}" \
    HERMES_IMAGE_REF="${HERMES_IMAGE_REF}" \
    HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME}" \
    CONTAINER_NAME="${CONTAINER_NAME}" \
    DATA_DIR="${DATA_DIR}" \
    ACP_PORT="${ACP_TCP_PORT}" \
    ACP_TCP_HOST="${ACP_TCP_HOST}" \
    bash "${patched_install_script}" "$@"

    normalize_runtime_entries
    patch_openclaw_runtime_for_hermes_toolset
    log_info "install-v4 执行完成"
}

main "$@"

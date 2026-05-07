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
PUBLIC_PLUGIN_URL="${PUBLIC_PLUGIN_URL:-${PUBLIC_BUCKET_BASE_URL}/openclaw-plugin-hermes-install-v4.tgz}"
RAW_REPO_BASE_URL="${RAW_REPO_BASE_URL:-https://raw.githubusercontent.com/marchpure/openclaw-hermes-harness/feat/hermes-runtime-bridge-productized-onecommit}"
REMOTE_REPO_URL="${REMOTE_REPO_URL:-https://github.com/marchpure/openclaw-hermes-harness.git}"
REMOTE_REPO_REF="${REMOTE_REPO_REF:-feat/hermes-runtime-bridge-productized-onecommit}"
NPM_REGISTRY_URL="${NPM_REGISTRY_URL:-https://registry.npmmirror.com}"
ALLOW_PUBLIC_PLUGIN_FALLBACK="${ALLOW_PUBLIC_PLUGIN_FALLBACK:-false}"
PREFER_PREBUILT_PLUGIN_URL="${PREFER_PREBUILT_PLUGIN_URL:-true}"

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
LOCAL_ACP_TCP_SERVER_PATCH="${REPO_ROOT:+${REPO_ROOT}/hermes-containerized/scripts/acp-tcp-server.py}"
REMOTE_ACP_TCP_SERVER_PATCH_URL="${REMOTE_ACP_TCP_SERVER_PATCH_URL:-${RAW_REPO_BASE_URL}/hermes-containerized/scripts/acp-tcp-server.py}"

MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION:-2026.4.15}"
DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR:-/var/cache/hermes-agent}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"

OPENCLAW_LARK_TOOL_ALLOWLIST=(
    "feishu_ask_user_question"
    "feishu_bitable_app"
    "feishu_bitable_app_table"
    "feishu_bitable_app_table_field"
    "feishu_bitable_app_table_record"
    "feishu_bitable_app_table_view"
    "feishu_calendar_calendar"
    "feishu_calendar_event"
    "feishu_calendar_event_attendee"
    "feishu_calendar_freebusy"
    "feishu_chat"
    "feishu_chat_members"
    "feishu_create_doc"
    "feishu_doc_comments"
    "feishu_doc_media"
    "feishu_drive_file"
    "feishu_fetch_doc"
    "feishu_get_user"
    "feishu_im_bot_image"
    "feishu_im_user_fetch_resource"
    "feishu_im_user_get_messages"
    "feishu_im_user_get_thread_messages"
    "feishu_im_user_message"
    "feishu_im_user_search_messages"
    "feishu_oauth"
    "feishu_oauth_batch_auth"
    "feishu_search_doc_wiki"
    "feishu_search_user"
    "feishu_sheet"
    "feishu_task_comment"
    "feishu_task_subtask"
    "feishu_task_task"
    "feishu_task_tasklist"
    "feishu_update_doc"
    "feishu_wiki_space"
    "feishu_wiki_space_node"
)

HERMES_IMAGE_REF="${HERMES_IMAGE_REF:-iaas-test01-cn-beijing.cr.volces.com/hermes/hermes-dockerimage:v1.2.0}"
HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"
CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}"
ACP_TCP_PORT="${ACP_TCP_PORT:-3100}"
ACP_PORT="${ACP_PORT:-${ACP_TCP_PORT}}"
ACP_TCP_SERVER_PATCH_HOST_PATH="${ACP_TCP_SERVER_PATCH_HOST_PATH:-${DATA_DIR}/openclaw-acp-tcp-server.py}"

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

normalize_port() {
    local name="$1" value="$2"
    [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} 必须是 1-65535 之间的整数，当前值: ${value}"
    local normalized=$((10#${value}))
    (( normalized >= 1 && normalized <= 65535 )) || die "${name} 必须是 1-65535 之间的整数，当前值: ${value}"
    printf '%s\n' "${normalized}"
}

TEMP_DIRS=()
RESOLVED_PLUGIN_SOURCE=""
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
    ACP_TCP_PORT="$(normalize_port "ACP_TCP_PORT" "${ACP_TCP_PORT}")"
    ACP_PORT="${ACP_TCP_PORT}"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" ]]; then
        command -v tar >/dev/null 2>&1 || die "缺少 tar，无法打包本地插件"
        command -v npm >/dev/null 2>&1 || die "缺少 npm，无法打包本地插件"
    elif command -v git >/dev/null 2>&1; then
        command -v tar >/dev/null 2>&1 || die "缺少 tar，无法打包远端插件"
        command -v npm >/dev/null 2>&1 || die "缺少 npm，无法打包远端插件"
    fi
}

ensure_plugin_build_artifacts() {
    local plugin_dir="$1"
    [[ -d "${plugin_dir}" ]] || die "插件目录不存在: ${plugin_dir}"
    [[ -f "${plugin_dir}/package.json" ]] || die "插件目录缺少 package.json: ${plugin_dir}"
    [[ -f "${plugin_dir}/openclaw.plugin.json" ]] || die "插件目录缺少 openclaw.plugin.json: ${plugin_dir}"

    if [[ ! -x "${plugin_dir}/node_modules/typescript/bin/tsc" ]]; then
        { log_info "安装 Hermes 插件构建依赖: ${plugin_dir}"; } >&2
        (cd "${plugin_dir}" && npm install --no-audit --no-fund --registry "${NPM_REGISTRY_URL}" >&2)
    fi

    [[ -x "${plugin_dir}/node_modules/typescript/bin/tsc" ]] || die "未找到 TypeScript 编译器: ${plugin_dir}/node_modules/typescript/bin/tsc"

    { log_info "编译 Hermes 插件 dist 产物"; } >&2
    (cd "${plugin_dir}" && node node_modules/typescript/lib/tsc.js >&2)

    [[ -f "${plugin_dir}/dist/index.js" ]] || die "Hermes 插件构建完成后缺少 dist/index.js"
}

pack_plugin_tarball() {
    local plugin_dir="$1" source_label="$2" tmp_dir pack_output plugin_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    ensure_plugin_build_artifacts "${plugin_dir}"
    { log_info "打包 ${source_label} Hermes 插件源码"; } >&2
    pack_output="$(cd "${plugin_dir}" && npm pack --pack-destination "${tmp_dir}" --json)"
    plugin_tar="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[0]["filename"])' <<<"${pack_output}")"
    RESOLVED_PLUGIN_SOURCE="${source_label}"
    printf '%s\n' "${tmp_dir}/${plugin_tar}"
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
        pack_plugin_tarball "${LOCAL_PLUGIN_DIR}" "当前仓库"
        return 0
    fi

    if [[ "${PREFER_PREBUILT_PLUGIN_URL}" == "true" ]]; then
        local tmp_dir plugin_tar
        tmp_dir="$(mktemp -d)"
        TEMP_DIRS+=("${tmp_dir}")
        plugin_tar="${tmp_dir}/openclaw-plugin-hermes-install-v4.tgz"
        if download_file "${PUBLIC_PLUGIN_URL}" "${plugin_tar}"; then
            RESOLVED_PLUGIN_SOURCE="公共预构建插件包"
            printf '%s\n' "${plugin_tar}"
            return 0
        fi
        log_warn "公共预构建插件包下载失败，将尝试源码打包: ${PUBLIC_PLUGIN_URL}"
    fi

    if command -v git >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
        local tmp_dir remote_repo remote_plugin_dir
        tmp_dir="$(mktemp -d)"
        TEMP_DIRS+=("${tmp_dir}")
        remote_repo="${tmp_dir}/repo"
        { log_info "拉取远端分支插件源码: ${REMOTE_REPO_URL}#${REMOTE_REPO_REF}"; } >&2
        if git clone --depth 1 --branch "${REMOTE_REPO_REF}" --single-branch "${REMOTE_REPO_URL}" "${remote_repo}" >&2; then
            remote_plugin_dir="${remote_repo}/openclaw-plugin-hermes"
            if [[ -f "${remote_plugin_dir}/openclaw.plugin.json" ]]; then
                pack_plugin_tarball "${remote_plugin_dir}" "远端分支 ${REMOTE_REPO_REF}"
                return 0
            fi
            die "远端分支缺少 openclaw-plugin-hermes/openclaw.plugin.json: ${REMOTE_REPO_URL}#${REMOTE_REPO_REF}"
        else
            log_warn "远端分支插件源码拉取失败: ${REMOTE_REPO_URL}#${REMOTE_REPO_REF}"
        fi
    fi

    if [[ "${ALLOW_PUBLIC_PLUGIN_FALLBACK}" != "true" ]]; then
        die "无法从当前仓库或远端分支构建 Hermes 插件包；默认禁止回退公共插件包。若确认需要旧公共包，请显式设置 ALLOW_PUBLIC_PLUGIN_FALLBACK=true"
    fi

    local tmp_dir plugin_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    plugin_tar="${tmp_dir}/openclaw-plugin-hermes-install-v3.tgz"
    download_file "${PUBLIC_PLUGIN_URL}" "${plugin_tar}"
    RESOLVED_PLUGIN_SOURCE="公共桶回退包"
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

sanitize_openclaw_config_for_current_schema() {
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    if command -v jq >/dev/null 2>&1; then
        if jq -e '.agents.defaults.agentRuntime? != null' "${OPENCLAW_CONFIG}" >/dev/null 2>&1; then
            local tmp
            tmp="$(mktemp)"
            TEMP_DIRS+=("${tmp}")
            jq 'del(.agents.defaults.agentRuntime)' "${OPENCLAW_CONFIG}" >"${tmp}" && mv "${tmp}" "${OPENCLAW_CONFIG}"
            log_info "已移除当前 OpenClaw schema 不兼容的 agents.defaults.agentRuntime"
        fi
    else
        python3 - "${OPENCLAW_CONFIG}" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
defaults = data.get("agents", {}).get("defaults")
if isinstance(defaults, dict) and "agentRuntime" in defaults:
    defaults.pop("agentRuntime", None)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
PYEOF
        log_info "已检查当前 OpenClaw schema 不兼容的 agents.defaults.agentRuntime"
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

def replace_once(label, old, new):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: patch anchor count={count}, expected 1")
    return text.replace(old, new, 1)

text = replace_once(
    "image source config",
    'TOS_IMAGE_URL="${TOS_IMAGE_URL:-https://scarif-${HERMES_REGION}.tos-${HERMES_REGION}.ivolces.com/arkclaw/hermes/hermes-image/hermes-agent-image.tar.gz}"',
    f'TOS_IMAGE_URL="${{TOS_IMAGE_URL:-}}"\nHERMES_IMAGE_REF="${{HERMES_IMAGE_REF:-{image_ref}}}"',
)
text = replace_once(
    "image name default",
    'HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"',
    'HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-${HERMES_IMAGE_REF}}"',
)
text = replace_once(
    "model candidate",
    'local oc_model_candidate="${OC_PRIMARY_MODEL:-${OC_DEFAULT_MODEL}}"',
    'local oc_model_candidate="${OC_DEFAULT_MODEL}"',
)
text = replace_once(
    "api provider selection",
    'choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "${OC_PROVIDER:-}" "ark" API_PROVIDER provider_source',
    'choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "${OC_PROVIDER:+custom}" "custom" API_PROVIDER provider_source',
)
text = replace_once("acp port default", 'ACP_PORT="${ACP_PORT:-3100}"', f'ACP_PORT="${{ACP_PORT:-{tcp_port}}}"')
text = replace_once("env acp tcp port", 'echo "ACP_TCP_PORT=3100"', 'echo "ACP_TCP_PORT=${ACP_PORT}"')
text = replace_once("env acp tcp host", 'echo "ACP_TCP_HOST=0.0.0.0"', f'echo "ACP_TCP_HOST=${{ACP_TCP_HOST:-{tcp_host}}}"')
text = replace_once(
    "config yaml provider patch",
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
text = replace_once(
    "provider base url env mapping",
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
text = replace_once(
    "docker image pull phase",
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
text = replace_once(
    "docker run command",
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
    '''    local -a openclaw_patch_mount=()
    if [[ -n "${ACP_TCP_SERVER_PATCH_HOST_PATH:-}" && -f "${ACP_TCP_SERVER_PATCH_HOST_PATH}" ]]; then
        openclaw_patch_mount=(-v "${ACP_TCP_SERVER_PATCH_HOST_PATH}:/opt/hermes/acp-tcp-server.py:ro")
        log_info "使用 OpenClaw patched ACP TCP server: ${ACP_TCP_SERVER_PATCH_HOST_PATH}"
    else
        log_warn "未找到 OpenClaw patched ACP TCP server，Hermes MCP bridge 将使用镜像内置 ACP server"
    fi

    docker run -d \\
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
        "${openclaw_patch_mount[@]}" \\
        --cpus="${CPU_LIMIT}" \\
        --memory="${MEM_LIMIT}" \\
        --log-driver json-file \\
        --log-opt max-size=20m \\
        --log-opt max-file=5 \\
        "${image_ref}" >/dev/null''',
)
text = replace_once(
    "jq plugin config block",
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
                 "hostBackedDenylist": ["browser", "browser-use", "feishu"],
                 "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use"],
                 "containerEnvSkillNames": [],
                 "alwaysExposeSkillNames": ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"]
               },
               "mcpBridge": {
                 "enabled": true,
                 "servers": {},
                 "env": {}
               }
           }''',
)
text = replace_once(
    "python plugin config block",
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
        'hostBackedDenylist': ['browser', 'browser-use', 'feishu'],
        'hostBackedSkillNames': ['lark-doc', 'lark-calendar', 'lark-im', 'lark-sheets', 'lark-base', 'lark-drive', 'lark-task', 'lark-mail', 'feishu', 'browser', 'browser-use'],
        'containerEnvSkillNames': [],
        'alwaysExposeSkillNames': ['browser-use', 'computer-use', 'byted-web-search', 'web_search', 'opencli', 'byted-seedream-image-generate', 'byted-seedance-video-generate', 'arkdrive-netdisk'],
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

        local lark_tools_json
        lark_tools_json="$(printf '%s\n' "${OPENCLAW_LARK_TOOL_ALLOWLIST[@]}" | jq -R . | jq -s .)"

        jq \
          --arg pk "${PLUGIN_CONFIG_KEY}" \
          --arg legacy_pk "hermes" \
          --arg cn "${CONTAINER_NAME}" \
          --arg dm "${default_model:-doubao-seed-2-0-pro-260215}" \
          --arg tcp_host "${ACP_TCP_HOST}" \
          --argjson tcp_port "${ACP_TCP_PORT}" \
          --argjson lark_tools "${lark_tools_json}" \
          '
          (.channels.feishu.enabled == true and (.channels.feishu.appId? // "" | length) > 0 and (.channels.feishu.appSecret? // "" | length) > 0) as $feishu_ready
          | del(.plugins.entries[$legacy_pk])
          | .plugins.allow = (((.plugins.allow // []) | map(select(. != $legacy_pk and . != "feishu"))) + [$pk] | unique)
          | if $feishu_ready then
              .tools = (.tools // {})
              | .tools.alsoAllow = (((.tools.alsoAllow // [])
                  | map(. as $tool | select($tool != "wecom_mcp" and ((($lark_tools | index($tool)) != null) or (($tool | startswith("feishu_")) | not))))
                ) + $lark_tools | unique)
            else
              .
            end
          | .plugins.entries.feishu = (.plugins.entries.feishu // {})
          | .plugins.entries.feishu.enabled = false
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
                "hostBackedDenylist": ["browser", "browser-use", "feishu"],
                "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use"],
                "containerEnvSkillNames": [],
                "alwaysExposeSkillNames": ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"]
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
        python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" "${CONTAINER_NAME}" "${ACP_TCP_HOST}" "${ACP_TCP_PORT}" "${OPENCLAW_LARK_TOOL_ALLOWLIST[*]}" <<'PYEOF'
import json, sys
cf, pk, cn, tcp_host, tcp_port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
lark_tools = sys.argv[6].split()
with open(cf) as f:
    data = json.load(f)
plugins = data.setdefault("plugins", {}).setdefault("entries", {})
plugins.pop("hermes", None)
plugins.setdefault("feishu", {})["enabled"] = False
feishu_cfg = data.get("channels", {}).get("feishu", {})
feishu_ready = (
    isinstance(feishu_cfg, dict)
    and feishu_cfg.get("enabled") is True
    and bool(feishu_cfg.get("appId"))
    and bool(feishu_cfg.get("appSecret"))
)
if feishu_ready:
    tools = data.setdefault("tools", {})
    current = tools.setdefault("alsoAllow", [])
    allow = [
        item for item in current
        if item != "wecom_mcp" and (item in lark_tools or not item.startswith("feishu_"))
    ]
    for item in lark_tools:
        if item not in allow:
            allow.append(item)
    tools["alsoAllow"] = allow
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
        "hostBackedDenylist": ["browser", "browser-use", "feishu"],
        "hostBackedSkillNames": ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use"],
        "containerEnvSkillNames": [],
        "alwaysExposeSkillNames": ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"],
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
allow = [item for item in allow if item not in ("hermes", "feishu")]
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

patch_hermes_plugin_manifest_schema() {
    local manifest="${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}/openclaw.plugin.json"
    [[ -f "${manifest}" ]] || return 0

    log_info "检查 Hermes 插件 manifest v4 配置 schema"

    if command -v jq >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp)"
        TEMP_DIRS+=("${tmp}")
        jq '
          .configSchema = (.configSchema // {})
          | .configSchema.properties = (.configSchema.properties // {})
          | .configSchema.properties.runtimeMinContextLevel = {
              "type": "string",
              "enum": ["L0", "L1", "L2", "L3"],
              "description": "Minimum context level projected for /model hermes agent harness attempts"
            }
          | .configSchema.properties.runtimeProjectWorkspaceSkills = {
              "type": "boolean",
              "description": "Expose OpenClaw-selected workspace skills to Hermes runtime projections"
            }
          | .configSchema.properties.mirrorExecEnvToContainer = {
              "type": "boolean",
              "description": "Mirror projected execution environments into the Hermes container before ACP turns"
            }
          | .configSchema.properties.skillProjection = (.configSchema.properties.skillProjection // {"type": "object", "additionalProperties": false, "properties": {}})
          | .configSchema.properties.skillProjection.properties = (.configSchema.properties.skillProjection.properties // {})
          | .configSchema.properties.skillProjection.properties.alwaysExposeSkillNames = {
              "type": "array",
              "items": { "type": "string" },
              "description": "Workspace skill names that should be projected into Hermes even when OpenClaw per-turn skill snapshot did not select them."
            }
        ' "${manifest}" > "${tmp}" && mv "${tmp}" "${manifest}"
    else
        python3 - "${manifest}" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
schema = data.setdefault("configSchema", {})
props = schema.setdefault("properties", {})
props["runtimeMinContextLevel"] = {
    "type": "string",
    "enum": ["L0", "L1", "L2", "L3"],
    "description": "Minimum context level projected for /model hermes agent harness attempts",
}
props["runtimeProjectWorkspaceSkills"] = {
    "type": "boolean",
    "description": "Expose OpenClaw-selected workspace skills to Hermes runtime projections",
}
props["mirrorExecEnvToContainer"] = {
    "type": "boolean",
    "description": "Mirror projected execution environments into the Hermes container before ACP turns",
}
skill = props.setdefault("skillProjection", {"type": "object", "additionalProperties": False, "properties": {}})
skill.setdefault("properties", {})["alwaysExposeSkillNames"] = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Workspace skill names that should be projected into Hermes even when OpenClaw per-turn skill snapshot did not select them.",
}
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PYEOF
    fi
}

sync_hermes_agent_models_cache() {
    local agent_models="${OPENCLAW_AGENT_MODELS:-/root/.openclaw/agents/main/agent/models.json}"
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    log_info "同步 Hermes provider 到 OpenClaw agent models.json"

    if command -v jq >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp)"
        TEMP_DIRS+=("${tmp}")
        mkdir -p "$(dirname "${agent_models}")"
        if [[ ! -f "${agent_models}" ]]; then
            printf '{"providers":{}}\n' > "${agent_models}"
        fi
        jq --slurpfile cfg "${OPENCLAW_CONFIG}" '
          .providers = (.providers // {})
          | .providers.hermes = $cfg[0].models.providers.hermes
        ' "${agent_models}" > "${tmp}" && mv "${tmp}" "${agent_models}"
        chmod 0600 "${agent_models}" 2>/dev/null || true
    else
        python3 - "${OPENCLAW_CONFIG}" "${agent_models}" <<'PYEOF'
import json, os, sys
config_path, models_path = sys.argv[1], sys.argv[2]
with open(config_path) as f:
    config = json.load(f)
hermes = config.get("models", {}).get("providers", {}).get("hermes")
if not hermes:
    sys.exit(0)
try:
    with open(models_path) as f:
        models = json.load(f)
except Exception:
    models = {}
models.setdefault("providers", {})["hermes"] = hermes
os.makedirs(os.path.dirname(models_path), exist_ok=True)
with open(models_path, "w") as f:
    json.dump(models, f, indent=2, ensure_ascii=False)
    f.write("\n")
try:
    os.chmod(models_path, 0o600)
except Exception:
    pass
PYEOF
    fi
}

patch_openclaw_lark_manifest_contracts() {
    local manifest="${OPENCLAW_EXTENSIONS_DIR}/openclaw-lark/openclaw.plugin.json"
    [[ -f "${manifest}" ]] || return 0

    log_info "检查 openclaw-lark manifest 工具契约"

    if command -v jq >/dev/null 2>&1; then
        local tmp lark_tools_json
        tmp="$(mktemp)"
        TEMP_DIRS+=("${tmp}")
        lark_tools_json="$(printf '%s\n' "${OPENCLAW_LARK_TOOL_ALLOWLIST[@]}" | jq -R . | jq -s .)"
        jq --argjson tools "${lark_tools_json}" '
          .contracts = (.contracts // {})
          | .contracts.tools = (((.contracts.tools // []) + $tools) | unique)
        ' "${manifest}" > "${tmp}" && mv "${tmp}" "${manifest}"
    else
        python3 - "${manifest}" "${OPENCLAW_LARK_TOOL_ALLOWLIST[*]}" <<'PYEOF'
import json, sys
path = sys.argv[1]
tools = sys.argv[2].split()
with open(path) as f:
    data = json.load(f)
contracts = data.setdefault("contracts", {})
existing = contracts.setdefault("tools", [])
for tool in tools:
    if tool not in existing:
        existing.append(tool)
with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
    fi

    log_info "openclaw-lark manifest contracts.tools 已补齐"
}

patch_openclaw_lark_ambient_tool_context() {
    local ticket_js="${OPENCLAW_EXTENSIONS_DIR}/openclaw-lark/src/core/lark-ticket.js"
    local ticket_dts="${OPENCLAW_EXTENSIONS_DIR}/openclaw-lark/src/core/lark-ticket.d.ts"
    [[ -f "${ticket_js}" ]] || {
        log_warn "未找到 openclaw-lark lark-ticket.js，跳过飞书 ambient tool context 补丁"
        return 0
    }

    log_info "检查 openclaw-lark ambient tool context 兼容补丁"

    python3 - "${ticket_js}" <<'PYEOF'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
if "OPENCLAW_TOOL_CONTEXT_STORAGE_KEY" in text:
    sys.exit(0)

needle = 'const store = new node_async_hooks_1.AsyncLocalStorage();'
helpers = r'''const OPENCLAW_TOOL_CONTEXT_STORAGE_KEY = "__openclawPluginToolContextStorage";
let openclawPluginSdk;
let openclawPluginSdkResolved = false;
function normalizeOptionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function readOpenClawPluginToolContextFromSdk() {
    if (!openclawPluginSdkResolved) {
        openclawPluginSdkResolved = true;
        try {
            openclawPluginSdk = require("openclaw/plugin-sdk");
        }
        catch {
            openclawPluginSdk = undefined;
        }
    }
    try {
        const getter = openclawPluginSdk?.getOpenClawPluginToolContext;
        return typeof getter === "function" ? getter() : undefined;
    }
    catch {
        return undefined;
    }
}
function readOpenClawPluginToolContextFromGlobal() {
    try {
        const storage = globalThis[OPENCLAW_TOOL_CONTEXT_STORAGE_KEY];
        return typeof storage?.getStore === "function" ? storage.getStore() : undefined;
    }
    catch {
        return undefined;
    }
}
function inferChatType(chatId, deliveryContext) {
    if (deliveryContext && typeof deliveryContext === "object") {
        const chatType = deliveryContext.chatType;
        if (chatType === "p2p" || chatType === "group") {
            return chatType;
        }
    }
    return typeof chatId === "string" && chatId.startsWith("oc_") ? "group" : "p2p";
}
function ticketFromOpenClawPluginToolContext() {
    const ctx = readOpenClawPluginToolContextFromSdk() ?? readOpenClawPluginToolContextFromGlobal();
    if (!ctx || ctx.messageChannel !== "feishu") {
        return undefined;
    }
    const accountId = normalizeOptionalString(ctx.agentAccountId);
    const chatId = normalizeOptionalString(ctx.currentChannelId) ??
        normalizeOptionalString(ctx.deliveryContext?.to);
    const messageId = normalizeOptionalString(String(ctx.currentMessageId ?? ""));
    const senderOpenId = normalizeOptionalString(ctx.requesterSenderId);
    if (!accountId || !chatId || !messageId || !senderOpenId) {
        return undefined;
    }
    const threadId = normalizeOptionalString(ctx.currentThreadTs) ??
        normalizeOptionalString(String(ctx.deliveryContext?.threadId ?? ""));
    return {
        messageId,
        chatId,
        accountId,
        startTime: Date.now(),
        senderOpenId,
        chatType: inferChatType(chatId, ctx.deliveryContext),
        ...(threadId ? { threadId } : {}),
    };
}'''
if needle not in text:
    raise SystemExit(f"patch anchor not found in {path}")
text = text.replace(needle, f"{needle}\n{helpers}", 1)
old_get_ticket = '''function getTicket() {
    return store.getStore();
}'''
new_get_ticket = '''function getTicket() {
    return store.getStore() ?? ticketFromOpenClawPluginToolContext();
}'''
if old_get_ticket not in text:
    raise SystemExit(f"getTicket implementation not found in {path}")
text = text.replace(old_get_ticket, new_get_ticket, 1)
old_elapsed = '    const t = store.getStore();'
if old_elapsed not in text:
    raise SystemExit(f"ticketElapsed store access not found in {path}")
text = text.replace(old_elapsed, '    const t = getTicket();', 1)
path.write_text(text)
PYEOF

    node -c "${ticket_js}"
    [[ ! -f "${ticket_dts}" ]] || grep -q "senderOpenId" "${ticket_dts}" || die "openclaw-lark lark-ticket.d.ts 缺少 senderOpenId 字段"
    log_info "openclaw-lark ambient tool context 兼容补丁已就绪"
}

patch_agent_identity_before_tool_call_context() {
    local identity_dist="${OPENCLAW_EXTENSIONS_DIR}/agent-identity/dist/index.mjs"
    [[ -f "${identity_dist}" ]] || {
        log_warn "未找到 agent-identity dist/index.mjs，跳过 before_tool_call 上下文补丁"
        return 0
    }

    log_info "检查 agent-identity before_tool_call sender context 兼容补丁"

    python3 - "${identity_dist}" <<'PYEOF'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(errors="surrogateescape")
marker = "hermes-context-patch"
if marker in text:
    sys.exit(0)

old = "let{toolName:m,params:h}=o,g=s.sessionKey;if(es(h,g,m,i),A(i,`before_tool_call tool=${m} session=${g??`?`}`),!g)return;let _=Oi(g,o.runId),v=lr(g);if(_r(v)){let e=Si(v);e&&(h._enhancedContext={senderId:e.senderId,senderName:e.senderName,from:e.from,channelId:e.channelId,messageId:e.messageId,sourceSessionKey:g,source:`group-latest`,capturedAt:e.capturedAt})}"
new = "let{toolName:m,params:h}=o,g=s.sessionKey;if(es(h,g,m,i),A(i,`before_tool_call tool=${m} session=${g??`?`}`),!g)return;let E=typeof s.requesterSenderId==`string`&&s.requesterSenderId.trim()?s.requesterSenderId.trim():typeof s.senderId==`string`&&s.senderId.trim()?s.senderId.trim():void 0,w=typeof s.messageChannel==`string`&&s.messageChannel.trim()?s.messageChannel.trim():typeof s.channelId==`string`&&s.channelId.trim()?s.channelId.trim():void 0,T=s.currentMessageId==null?void 0:String(s.currentMessageId).trim()||void 0,_=E?Ti(g,E,w):Oi(g,o.runId),v=lr(g);if(_r(v)){let e=Si(v);!e&&E&&(e={senderId:E,channelId:w,messageId:T,capturedAt:Date.now(),source:`hermes-context-patch`});e&&(h._enhancedContext={senderId:e.senderId,senderName:e.senderName,from:e.from,channelId:e.channelId,messageId:e.messageId,sourceSessionKey:g,source:e.source??`group-latest`,capturedAt:e.capturedAt})}"
count = text.count(old)
if count != 1:
    raise SystemExit(f"agent-identity before_tool_call patch anchor count={count}, expected 1")
path.write_text(text.replace(old, new, 1), errors="surrogateescape")
PYEOF

    node -c "${identity_dist}"
    log_info "agent-identity before_tool_call sender context 兼容补丁已就绪"
}

patch_openclaw_runtime_for_hermes_toolset() {
    if ! command -v openclaw >/dev/null 2>&1; then
        log_warn "未找到 openclaw CLI，跳过 Hermes MCP bridge 能力校验"
        return 0
    fi
    command -v node >/dev/null 2>&1 || die "缺少 node，无法校验 OpenClaw MCP bridge SDK helper"

    if node <<'NODE' >/dev/null 2>&1
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const candidates = [];
  try {
    candidates.push(require.resolve("openclaw/plugin-sdk/agent-harness-runtime"));
  } catch {}
  try {
    const sdkEntry = require.resolve("openclaw/plugin-sdk/agent-harness");
    const packageRoot = path.dirname(path.dirname(sdkEntry));
    candidates.push(path.join(packageRoot, "plugin-sdk", "agent-harness-runtime.js"));
  } catch {}
  candidates.push("/usr/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js");
  candidates.push("/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js");

  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.prepareAgentHarnessMcpBridge === "function") {
        process.exit(0);
      }
    } catch {}
  }
  process.exit(1);
})();
NODE
    then
        log_info "OpenClaw MCP bridge SDK helper 已就绪"
        return 0
    fi

    local runtime_js="/usr/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js"
    local runtime_dts="/usr/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.d.ts"
    local package_json="/usr/lib/node_modules/openclaw/package.json"
    if [[ ! -d "$(dirname "${runtime_js}")" || ! -f "${package_json}" ]]; then
        die "当前 OpenClaw 未暴露 prepareAgentHarnessMcpBridge，且未找到可补齐的全局 OpenClaw SDK 路径"
    fi

    log_info "补齐 OpenClaw MCP bridge SDK helper: ${runtime_js}"
    cat >"${runtime_js}" <<'JSEOF'
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRecord(value) {
  return isRecord(value) ? { ...value } : {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function resolveOpenClawRoot() {
  return path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
}

function resolvePluginToolsMcpServer() {
  return {
    command: process.execPath,
    args: [path.join(resolveOpenClawRoot(), "dist", "mcp", "plugin-tools-serve.js")],
  };
}

function normalizeConfiguredServers(params) {
  const servers = normalizeRecord(params.configuredServers);
  const cfg = isRecord(params.config) ? params.config : {};
  const configured = isRecord(cfg.mcp) ? normalizeRecord(cfg.mcp.servers) : {};
  return { ...configured, ...servers };
}

function normalizeEnv(params) {
  const configured = normalizeRecord(params.configuredEnv);
  return Object.fromEntries(
    Object.entries(configured).filter((entry) => typeof entry[1] === "string"),
  );
}

function buildContextEnv(params) {
  return Object.fromEntries(
    Object.entries({
      OPENCLAW_AGENT_ID: readString(params.agentId),
      OPENCLAW_ACCOUNT_ID: readString(params.accountId),
      OPENCLAW_SESSION_KEY: readString(params.sessionKey),
      OPENCLAW_WORKSPACE_DIR: readString(params.workspaceDir),
      OPENCLAW_MESSAGE_CHANNEL: readString(params.messageChannel ?? params.messageProvider),
      OPENCLAW_MESSAGE_TO: readString(params.messageTo),
      OPENCLAW_MESSAGE_THREAD_ID: params.messageThreadId == null ? undefined : String(params.messageThreadId),
      OPENCLAW_CURRENT_CHANNEL_ID: readString(params.currentChannelId),
      OPENCLAW_CURRENT_THREAD_TS: readString(params.currentThreadTs),
      OPENCLAW_CURRENT_MESSAGE_ID: params.currentMessageId == null ? undefined : String(params.currentMessageId),
      OPENCLAW_REQUESTER_SENDER_ID: readString(params.requesterSenderId),
      OPENCLAW_SENDER_IS_OWNER: typeof params.senderIsOwner === "boolean" ? String(params.senderIsOwner) : undefined,
    }).filter((entry) => entry[1] !== undefined),
  );
}

export async function prepareAgentHarnessMcpBridge(params = {}) {
  if (params.enabled === false) return {};
  const mcpServers = normalizeConfiguredServers(params);
  if (!mcpServers["openclaw-plugin-tools"]) {
    mcpServers["openclaw-plugin-tools"] = resolvePluginToolsMcpServer();
  }
  const env = {
    ...normalizeEnv(params),
    ...buildContextEnv(params),
  };
  const mcpConfigHash = hashJson(mcpServers);
  const credentialScopeHash = hashJson(Object.keys(env).sort());
  return {
    mcpServers,
    env,
    mcpConfigHash,
    mcpResumeHash: hashJson({
      mcpConfigHash,
      sessionKey: readString(params.sessionKey),
      agentId: readString(params.agentId),
      workspaceDir: readString(params.workspaceDir),
    }),
    credentialScopeHash,
  };
}
JSEOF
    cat >"${runtime_dts}" <<'DTSEOF'
export type AgentHarnessMcpBridge = {
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  credentialScopeHash?: string;
};
export declare function prepareAgentHarnessMcpBridge(params?: Record<string, unknown>): Promise<AgentHarnessMcpBridge>;
DTSEOF

    node -c "${runtime_js}"
    if ! node <<'NODE' >/dev/null 2>&1
const { pathToFileURL } = require("node:url");
(async () => {
  const mod = await import(pathToFileURL("/usr/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js").href);
  process.exit(typeof mod.prepareAgentHarnessMcpBridge === "function" ? 0 : 1);
})();
NODE
    then
        die "OpenClaw MCP bridge SDK helper 补齐后校验失败"
    fi
    log_info "OpenClaw MCP bridge SDK helper 已补齐"
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

prepare_acp_tcp_server_patch() {
    if [[ -f "${LOCAL_ACP_TCP_SERVER_PATCH}" ]]; then
        mkdir -p "${DATA_DIR}"
        cp -f "${LOCAL_ACP_TCP_SERVER_PATCH}" "${ACP_TCP_SERVER_PATCH_HOST_PATH}"
        chmod 0644 "${ACP_TCP_SERVER_PATCH_HOST_PATH}"
        log_info "已准备 OpenClaw patched ACP TCP server: ${ACP_TCP_SERVER_PATCH_HOST_PATH}"
        return 0
    fi

    mkdir -p "${DATA_DIR}"
    if download_file "${REMOTE_ACP_TCP_SERVER_PATCH_URL}" "${ACP_TCP_SERVER_PATCH_HOST_PATH}.tmp"; then
        mv -f "${ACP_TCP_SERVER_PATCH_HOST_PATH}.tmp" "${ACP_TCP_SERVER_PATCH_HOST_PATH}"
        chmod 0644 "${ACP_TCP_SERVER_PATCH_HOST_PATH}"
        log_info "已下载 OpenClaw patched ACP TCP server: ${REMOTE_ACP_TCP_SERVER_PATCH_URL}"
        return 0
    fi
    rm -f "${ACP_TCP_SERVER_PATCH_HOST_PATH}.tmp"

    log_warn "未找到本地 patched ACP TCP server 源文件，且远端下载失败: ${REMOTE_ACP_TCP_SERVER_PATCH_URL}"
    return 0
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
    log_info "使用 ${RESOLVED_PLUGIN_SOURCE:-未知来源} 的 Hermes 插件包安装: ${plugin_tar}"
    log_info "要求 OpenClaw 版本 >= ${MIN_OPENCLAW_VERSION}"
    log_info "Hermes v4 镜像: ${HERMES_IMAGE_REF}"
    log_info "Hermes ACP 监听: ${ACP_TCP_HOST}:${ACP_TCP_PORT}"

    sanitize_openclaw_config_for_current_schema
    invalidate_cached_plugin_archive
    prepare_acp_tcp_server_patch

    MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION}" \
    DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR}" \
    TOS_PLUGIN_URL="file://${plugin_tar}" \
    HERMES_IMAGE_REF="${HERMES_IMAGE_REF}" \
    HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME}" \
    CONTAINER_NAME="${CONTAINER_NAME}" \
    DATA_DIR="${DATA_DIR}" \
    ACP_PORT="${ACP_TCP_PORT}" \
    ACP_TCP_HOST="${ACP_TCP_HOST}" \
    ACP_TCP_SERVER_PATCH_HOST_PATH="${ACP_TCP_SERVER_PATCH_HOST_PATH}" \
    bash "${patched_install_script}" "$@"

    patch_hermes_plugin_manifest_schema
    normalize_runtime_entries
    sync_hermes_agent_models_cache
    patch_openclaw_lark_manifest_contracts
    patch_openclaw_lark_ambient_tool_context
    patch_agent_identity_before_tool_call_context
    patch_openclaw_runtime_for_hermes_toolset
    log_info "install-v4 执行完成"
}

main "$@"

#!/usr/bin/env bash
# Hermes Harness Runtime v6 安装/升级脚本
# 支持:
# 1. 本地仓库执行: bash scripts/install-v6.sh
# 2. 远端直执行: curl -fsSL .../install-v6.sh | bash
# 3. Fresh install / legacy upgrade 均可
#
# v6 仅负责安装部署；Hermes provider/catalog/harness 能力由插件代码声明:
# - 使用镜像仓库引用启动 Hermes runtime，避免下载 TOS tar 后 docker load。
# - 安装 Hermes 插件包并补齐插件运行配置。
# - 仅写入 /model hermes 所需的 hermes/default alias。
# - 不写 agentRuntime、agentRuntimeOverride、agentHarnessId pin 或 legacy provider config。

set -Eeuo pipefail

PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
BASE_INSTALL_URL="${BASE_INSTALL_URL:-${PUBLIC_BUCKET_BASE_URL}/hermes-install.sh}"
RAW_REPO_BASE_URL="${RAW_REPO_BASE_URL:-https://raw.githubusercontent.com/marchpure/openclaw-hermes-harness/feat/hermes-runtime-bridge-productized-squashed-from-1ca5fc3}"
PUBLIC_PLUGIN_URL="${PUBLIC_PLUGIN_URL:-${RAW_REPO_BASE_URL}/openclaw-plugin-hermes-install-v6.tgz}"
REMOTE_REPO_URL="${REMOTE_REPO_URL:-https://github.com/marchpure/openclaw-hermes-harness.git}"
REMOTE_REPO_REF="${REMOTE_REPO_REF:-feat/hermes-runtime-bridge-productized-squashed-from-1ca5fc3}"
NPM_REGISTRY_URL="${NPM_REGISTRY_URL:-https://registry.npmmirror.com}"
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

MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION:-2026.5.7}"
DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR:-/var/cache/hermes-agent}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"

HERMES_IMAGE_REF="${HERMES_IMAGE_REF:-scarif-2120977246-cn-beijing.cr.volces.com/hermes/hermes-agent:v1.2.0}"
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
    command -v python3 >/dev/null 2>&1 || die "缺少 python3，无法 patch v6 runtime installer"
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
        pack_plugin_tarball "${LOCAL_PLUGIN_DIR}" "当前仓库"
        return 0
    fi

    if [[ "${PREFER_PREBUILT_PLUGIN_URL}" == "true" ]]; then
        local tmp_dir plugin_tar
        tmp_dir="$(mktemp -d)"
        TEMP_DIRS+=("${tmp_dir}")
        plugin_tar="${tmp_dir}/openclaw-plugin-hermes-install-v6.tgz"
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
        fi
        log_warn "远端分支插件源码拉取失败: ${REMOTE_REPO_URL}#${REMOTE_REPO_REF}"
    fi

    local tmp_dir plugin_tar
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    plugin_tar="${tmp_dir}/openclaw-plugin-hermes-install-v6.tgz"
    download_file "${PUBLIC_PLUGIN_URL}" "${plugin_tar}"
    RESOLVED_PLUGIN_SOURCE="公共桶回退包"
    printf '%s\n' "${plugin_tar}"
}

create_v6_base_installer() {
    local source_script="$1"
    local tmp_dir patched_script
    tmp_dir="$(mktemp -d)"
    TEMP_DIRS+=("${tmp_dir}")
    patched_script="${tmp_dir}/hermes-install-v6-patched.sh"

    HERMES_IMAGE_REF="${HERMES_IMAGE_REF}" \
    ACP_TCP_HOST="${ACP_TCP_HOST}" \
    ACP_TCP_PORT="${ACP_TCP_PORT}" \
    python3 - "${source_script}" "${patched_script}" <<'PYEOF'
import os
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
text = replace_once("acp port default", 'ACP_PORT="${ACP_PORT:-3100}"', f'ACP_PORT="${{ACP_PORT:-{tcp_port}}}"')
text = replace_once("env acp tcp port", 'echo "ACP_TCP_PORT=3100"', 'echo "ACP_TCP_PORT=${ACP_PORT}"')
text = replace_once("env acp tcp host", 'echo "ACP_TCP_HOST=0.0.0.0"', f'echo "ACP_TCP_HOST=${{ACP_TCP_HOST:-{tcp_host}}}"')
old_hermes_provider_ref = "." + "models" + "." + "providers" + "." + "hermes"
text = replace_once(
    "legacy provider comment",
    "# - 安装完成后会向 OpenClaw 注入一个合成 provider: " + old_hermes_provider_ref[1:],
    "# - 安装完成后只写 /model hermes 所需的 hermes/default alias；provider/catalog 由插件声明。",
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
text = replace_once(
    "legacy provider injection jq",
    ('''           | .agents.defaults.models = ((.agents.defaults.models // {}) + {
               "hermes/default": { "alias": "hermes" }
             })
           | ''' + old_hermes_provider_ref + ''' = {
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
             }'''),
    '''           | .agents.defaults.models = (.agents.defaults.models // {})
           | .agents.defaults.models["hermes/default"] =
               ((.agents.defaults.models["hermes/default"] // {}) + { "alias": "hermes" })''',
)
text = replace_once(
    "legacy provider injection python",
    '''d.setdefault('agents', {}).setdefault('defaults', {}).setdefault('models', {}).update({
    'hermes/default': {'alias': 'hermes'},
})
d.setdefault('models', {}).setdefault('providers', {})['hermes'] = {
    'baseUrl': 'http://127.0.0.1/hermes-runtime',
    'apiKey': 'hermes-runtime',
    'auth': 'token',
    'api': 'openai-responses',
    'models': [
        {
            'id': 'default',
            'name': 'default',
            'reasoning': True,
            'input': ['text', 'image'],
            'contextWindow': 200000,
            'maxTokens': 32000,
        },
    ],
}''',
    '''agent_defaults = d.setdefault('agents', {}).setdefault('defaults', {})
agent_models = agent_defaults.setdefault('models', {})
hermes_model = agent_models.get('hermes/default')
if not isinstance(hermes_model, dict):
    hermes_model = {}
hermes_model['alias'] = 'hermes'
agent_models['hermes/default'] = hermes_model''',
)
text = replace_once(
    "plugin install force upgrade",
    'local install_args=("${plugin_path}")',
    'local install_args=("${plugin_path}" "--force")',
)

dst.write_text(text)
dst.chmod(0o755)
PYEOF

    printf '%s\n' "${patched_script}"
}

detect_existing_installation() {
    local found=false
    local legacy_provider_path
    legacy_provider_path="$(printf '%s.%s.%s' models providers hermes)"
    if [[ -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}" || -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}" ]]; then
        found=true
    fi

    if [[ -f "${OPENCLAW_CONFIG}" ]]; then
        if command -v jq >/dev/null 2>&1; then
            if jq -e --arg pk "${PLUGIN_CONFIG_KEY}" --arg legacy_path "${legacy_provider_path}" '.plugins.entries[$pk] != null or getpath($legacy_path | split(".")) != null or .agents.defaults.models["hermes/default"] != null' "${OPENCLAW_CONFIG}" >/dev/null 2>&1; then
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

    log_info "补齐 Hermes runtime v6 配置归一化"
    local config_dir
    config_dir="$(dirname "${OPENCLAW_CONFIG}")"

    if command -v jq >/dev/null 2>&1; then
        local tmp default_model
        tmp="$(mktemp "${config_dir}/openclaw.json.tmp.XXXXXX")"
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
          .plugins = (.plugins // {})
          | .plugins.entries = (.plugins.entries // {})
          | del(.plugins.entries[$legacy_pk])
          | .plugins.allow = (((.plugins.allow // []) | map(select(. != $legacy_pk))) + [$pk] | unique)
          | .plugins.entries[$pk] = (.plugins.entries[$pk] // {})
          | .plugins.entries[$pk].enabled = true
          | (.plugins.entries[$pk].config // {}) as $cfg
          | .plugins.entries[$pk].config = ($cfg + {
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
                "hostBackedDenylist": (((($cfg.skillProjection.hostBackedDenylist // []) + ["browser", "browser-use", "feishu"]) | unique)),
                "hostBackedSkillNames": (((($cfg.skillProjection.hostBackedSkillNames // []) + ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use", "arkdrive-netdisk", "workspace-netdrive"]) | unique)),
                "containerEnvSkillNames": ($cfg.skillProjection.containerEnvSkillNames // []),
                "alwaysExposeSkillNames": (((($cfg.skillProjection.alwaysExposeSkillNames // []) + ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"]) | unique))
              },
              "mcpBridge": {
                "enabled": true,
                "servers": ($cfg.mcpBridge.servers // {}),
                "env": ($cfg.mcpBridge.env // {})
              }
            })
          | .agents = (.agents // {})
          | .agents.defaults = (.agents.defaults // {})
          | .agents.defaults.models = (.agents.defaults.models // {})
          | .agents.defaults.models["hermes/default"] =
              ((.agents.defaults.models["hermes/default"] // {}) + { "alias": "hermes" })
          ' "${OPENCLAW_CONFIG}" > "${tmp}" || die "OpenClaw 配置归一化失败: jq 写入失败"
        mv "${tmp}" "${OPENCLAW_CONFIG}"
    elif command -v python3 >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp "${config_dir}/openclaw.json.tmp.XXXXXX")"
        TEMP_DIRS+=("${tmp}")
        python3 - "${OPENCLAW_CONFIG}" "${tmp}" "${PLUGIN_CONFIG_KEY}" "${CONTAINER_NAME}" "${ACP_TCP_HOST}" "${ACP_TCP_PORT}" <<'PYEOF' || die "OpenClaw 配置归一化失败: python 写入失败"
import json, sys
cf, tmp, pk, cn, tcp_host, tcp_port = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6])
with open(cf) as f:
    data = json.load(f)
plugins = data.setdefault("plugins", {}).setdefault("entries", {})
plugins.pop("hermes", None)
entry = plugins.setdefault(pk, {})
entry["enabled"] = True
cfg = entry.setdefault("config", {})
cfg.setdefault("defaultModel", "doubao-seed-2-0-pro-260215")
skill_cfg = cfg.get("skillProjection") if isinstance(cfg.get("skillProjection"), dict) else {}
mcp_cfg = cfg.get("mcpBridge") if isinstance(cfg.get("mcpBridge"), dict) else {}

def unique(values):
    out = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        key = value.strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(value.strip())
    return out

cfg.update({
    "hermesContainerName": cn,
    "defaultModel": cfg.get("defaultModel", "doubao-seed-2-0-pro-260215"),
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
        "hostBackedDenylist": unique(skill_cfg.get("hostBackedDenylist", []) + ["browser", "browser-use", "feishu"]),
        "hostBackedSkillNames": unique(skill_cfg.get("hostBackedSkillNames", []) + ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use", "arkdrive-netdisk", "workspace-netdrive"]),
        "containerEnvSkillNames": unique(skill_cfg.get("containerEnvSkillNames", [])),
        "alwaysExposeSkillNames": unique(skill_cfg.get("alwaysExposeSkillNames", []) + ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"]),
    },
    "mcpBridge": {
        "enabled": True,
        "servers": mcp_cfg.get("servers", {}) if isinstance(mcp_cfg.get("servers"), dict) else {},
        "env": mcp_cfg.get("env", {}) if isinstance(mcp_cfg.get("env"), dict) else {},
    },
})
agent_defaults = data.setdefault("agents", {}).setdefault("defaults", {})
agent_models = agent_defaults.setdefault("models", {})
hermes_model = agent_models.get("hermes/default")
if not isinstance(hermes_model, dict):
    hermes_model = {}
hermes_model["alias"] = "hermes"
agent_models["hermes/default"] = hermes_model
allow = data.setdefault("plugins", {}).setdefault("allow", [])
allow = [item for item in allow if item != "hermes"]
if pk not in allow:
    allow.append(pk)
data["plugins"]["allow"] = allow
with open(tmp, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
        mv "${tmp}" "${OPENCLAW_CONFIG}"
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

ensure_openclaw_runtime_supports_hermes_toolset() {
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

    die "当前 OpenClaw 缺少 plugin-sdk/agent-harness-runtime helper；install-v6 不修改 OpenClaw core，请先升级到包含该 helper 的 OpenClaw 版本后重试"
}

main() {
    check_prereqs
    detect_existing_installation

    local base_install_script
    base_install_script="$(resolve_base_install_script)"

    local patched_install_script
    patched_install_script="$(create_v6_base_installer "${base_install_script}")"

    local plugin_tar
    plugin_tar="$(resolve_plugin_tarball)"
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
        log_info "使用当前仓库 Hermes 插件包安装: ${plugin_tar}"
    else
        log_info "使用远端/预构建 Hermes 插件包安装: ${plugin_tar}"
    fi
    log_info "要求 OpenClaw 版本 >= ${MIN_OPENCLAW_VERSION}"
    log_info "Hermes runtime 镜像: ${HERMES_IMAGE_REF}"
    log_info "Hermes ACP 监听: ${ACP_TCP_HOST}:${ACP_TCP_PORT}"

    # 旧版 install-v2 可能把错误插件包缓存到固定路径
    # /var/cache/hermes-agent/hermes-plugin.tar.gz。这里只失效插件缓存，
    # 不动大镜像缓存，避免每次都重新加载 1.1G 镜像。
    invalidate_cached_plugin_archive
    ensure_openclaw_runtime_supports_hermes_toolset

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
    ensure_openclaw_runtime_supports_hermes_toolset
    log_info "install-v6 执行完成"
}

main "$@"

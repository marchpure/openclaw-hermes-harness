#!/usr/bin/env bash
# Hermes Agent v2 安装/升级脚本
# 基于 install-v3.sh，融合 install-v5.sh 的 runtime 配置增强
# 变更 (相对 v3):
# - 镜像从仓库 docker pull（不再下载 tar 包）
# - 支持后台安装（--background）
# - 插件先卸载再安装
# - 归一化 openclaw.json 配置（含 agentRuntime）
# - [v2 新增] normalize_runtime_entries() 增量合并配置，保留已有 skillProjection/mcpBridge
# - [v2 新增] patch_openclaw_runtime_for_hermes_toolset() MCP bridge SDK helper
# - [v2 新增] detect_existing_installation() 检测已有安装
# - [v2 新增] invalidate_cached_plugin_archive() 精确清理插件缓存

set -Eeuo pipefail

# ─── 地域与账号检测 ──────────────────────────────────────────────────────────
HERMES_REGION="${HERMES_REGION:-}"
if [[ -z "${HERMES_REGION}" ]]; then
    HERMES_REGION=$(curl --connect-timeout 5 --max-time 10 -s "http://100.96.0.96/latest/region_id" || echo "")
fi
if [[ -z "${HERMES_REGION}" ]]; then
    HERMES_REGION="cn-beijing"
fi

HERMES_ACCOUNT_ID="${HERMES_ACCOUNT_ID:-}"
if [[ -z "${HERMES_ACCOUNT_ID}" ]]; then
    HERMES_ACCOUNT_ID=$(curl --connect-timeout 5 --max-time 10 -s "http://100.96.0.96/latest/owner_account_id" || echo "")
fi

# stg 环境资源账号 HERMES_ACCOUNT_ID=2122135917，ppe 环境资源账号 HERMES_ACCOUNT_ID=2121009813，2122149482
# 这些环境需要走公网从资源账号 2120977246 下载镜像
if [[ "${HERMES_ACCOUNT_ID}" == "2122135917" || "${HERMES_ACCOUNT_ID}" == "2121009813" || "${HERMES_ACCOUNT_ID}" == "2122149482" ]]; then
    HERMES_ACCOUNT_ID="2120977246"
fi


# ─── 配置 ────────────────────────────────────────────────────────────────────
HERMES_DOCKER_IMAGE="${HERMES_DOCKER_IMAGE:-scarif-${HERMES_ACCOUNT_ID}-${HERMES_REGION}.cr.volces.com/hermes/hermes-agent:v1.2.0}"
PLUGIN_VERSION="${PLUGIN_VERSION:-2.0.0}"
PUBLIC_PLUGIN_URL="${PUBLIC_PLUGIN_URL:-https://scarif-${HERMES_REGION}.tos-${HERMES_REGION}.ivolces.com/arkclaw/hermes/hermes-plugin/openclaw-plugin-hermes-${PLUGIN_VERSION}.tgz}"

SCRIPT_SOURCE="${BASH_SOURCE[0]-}"
if [[ -n "${SCRIPT_SOURCE}" && -e "${SCRIPT_SOURCE}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd)"
    REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
    SCRIPT_DIR=""
    REPO_ROOT=""
fi

LOCAL_PLUGIN_DIR="${REPO_ROOT:+${REPO_ROOT}/openclaw-plugin-hermes}"

HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"
CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
CACHE_DIR="${CACHE_DIR:-/var/cache/hermes-agent}"
ACP_PORT="${ACP_PORT:-3100}"
ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}"
ACP_TCP_PORT="${ACP_TCP_PORT:-3100}"
NPM_REGISTRY_URL="${NPM_REGISTRY_URL:-https://registry.npmmirror.com}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-180}"
HEALTH_CHECK_POST_START_GRACE="${HEALTH_CHECK_POST_START_GRACE:-20}"
MIN_FREE_SPACE_GB="${MIN_FREE_SPACE_GB:-5}"
MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION:-2026.4.15}"
OPENCLAW_GATEWAY_READY_TIMEOUT="${OPENCLAW_GATEWAY_READY_TIMEOUT:-30}"
OPENCLAW_GATEWAY_FALLBACK_SLEEP="${OPENCLAW_GATEWAY_FALLBACK_SLEEP:-5}"
OPENCLAW_GATEWAY_RESTART_RETRIES="${OPENCLAW_GATEWAY_RESTART_RETRIES:-3}"
OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP="${OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP:-5}"

# ─── 运行时变量 ──────────────────────────────────────────────────────────────
API_KEY=""
API_PROVIDER=""
DEFAULT_MODEL_VAL=""
API_BASE_URL=""
CPU_LIMIT=""
MEM_LIMIT=""
DOCKER_ROOT_DIR=""

CLI_API_KEY=""
CLI_API_PROVIDER=""
CLI_DEFAULT_MODEL=""
CLI_API_BASE_URL=""

RUN_TS=""
LOG_DIR=""
LOG_FILE=""
BACKUP_DIR=""
OPENCLAW_CONFIG_BACKUP=""
HERMES_CONFIG_BACKUP=""
ENV_FILE_BACKUP=""
PLUGIN_DIR_BACKUP=""
ROLLBACK_IMAGE_TAG=""
PREVIOUS_IMAGE_ID=""

ROLLBACK_ARMED=false
ROLLBACK_IN_PROGRESS=false
PREVIOUS_IMAGE_PRESENT=false
PREVIOUS_CONTAINER_PRESENT=false
PREVIOUS_CONTAINER_RUNNING=false
HERMES_CONFIG_EXISTED=false
ENV_FILE_EXISTED=false
PLUGIN_DIR_EXISTED=false

declare -a PLUGIN_DIR_CANDIDATES=()

# ─── 后台安装变量 ────────────────────────────────────────────────────────────
INSTALL_STATUS_DIR="${CACHE_DIR}"
INSTALL_STATUS_PREFIX=".install"
TMUX_SESSION_NAME="hermes-install"
BACKGROUND_MODE=false

# ─── 颜色 ────────────────────────────────────────────────────────────────────
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
log_step()  { printf '\n%b%s [STEP]%b %s\n' "${CYAN}" "$(timestamp)" "${NC}" "$1"; }
die() {
    log_error "$@"
    # 显式 exit 不会触发 ERR trap，这里主动写入 failed 状态，
    # 避免 .install-running-* 状态文件残留导致后续无法二次安装
    write_install_status "failed" 1 2>/dev/null || true
    if [[ "${ROLLBACK_ARMED:-false}" == true && "${ROLLBACK_IN_PROGRESS:-false}" != true ]]; then
        rollback_upgrade
    fi
    exit 1
}

# ─── 临时文件清理 ─────────────────────────────────────────────────────────────
TEMP_FILES=()
cleanup_temp() {
    for f in "${TEMP_FILES[@]+"${TEMP_FILES[@]}"}"; do
        rm -rf "${f}" 2>/dev/null || true
    done
}
trap cleanup_temp EXIT
register_temp() { TEMP_FILES+=("$1"); }

mask_secret() {
    local value="$1"
    local len="${#value}"
    if (( len <= 8 )); then
        printf '****'
    else
        printf '%s...%s' "${value:0:4}" "${value: -4}"
    fi
}

normalize_port() {
    local name="$1" value="$2"
    [[ "${value}" =~ ^[0-9]+$ ]] || die "${name} 必须是 1-65535 之间的整数，当前值: ${value}"
    local normalized=$((10#${value}))
    (( normalized >= 1 && normalized <= 65535 )) || die "${name} 必须是 1-65535 之间的整数，当前值: ${value}"
    printf '%s\n' "${normalized}"
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
usage() {
    cat <<'EOF'
Hermes Agent v2 部署 / 安全升级脚本

选项:
  --background                      后台模式（脱离终端运行）
  --status                          查看当前安装状态
  --cleanup, --clean, --uninstall   执行清理流程
  --api-key <value>                 显式指定 API Key（建议使用 HERMES_API_KEY 环境变量）
  --provider <value>                显式指定 Provider
  --model <value>                   显式指定默认模型
  --base-url <value>                显式指定 API Base URL
  --help, -h                        显示帮助

优先级:
  CLI 参数 > HERMES_* 环境变量 > OpenClaw 配置 > 内置默认值
EOF
}

require_arg_value() {
    local option_name="$1" option_value="${2:-}"
    [[ -n "${option_value}" ]] || die "参数 ${option_name} 缺少值"
}

CLEANUP_REQUESTED=false

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --background)
                BACKGROUND_MODE=true
                ;;
            --status)
                show_install_status
                exit 0
                ;;
            --cleanup|--clean|--uninstall)
                CLEANUP_REQUESTED=true
                ;;
            --api-key)
                shift
                require_arg_value "--api-key" "${1:-}"
                CLI_API_KEY="$1"
                log_warn "通过 --api-key 传递密钥存在安全风险，建议使用 HERMES_API_KEY 环境变量"
                ;;
            --provider)
                shift
                require_arg_value "--provider" "${1:-}"
                CLI_API_PROVIDER="$1"
                ;;
            --model)
                shift
                require_arg_value "--model" "${1:-}"
                CLI_DEFAULT_MODEL="$1"
                ;;
            --base-url)
                shift
                require_arg_value "--base-url" "${1:-}"
                CLI_API_BASE_URL="$1"
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                die "未知参数: $1"
                ;;
        esac
        shift
    done

    # 优先使用环境变量
    if [[ -z "${API_KEY:-}" && -n "${HERMES_API_KEY:-}" ]]; then
        API_KEY="${HERMES_API_KEY}"
    fi
}

# ─── 后台安装支持 ─────────────────────────────────────────────────────────────

status_ts() { date '+%Y%m%d%H%M%S'; }

write_install_status() {
    local status="${1}" exit_code="${2:-0}"

    mkdir -p "${INSTALL_STATUS_DIR}" 2>/dev/null || true

    local ts
    ts="$(status_ts)"
    local my_pid="${BASHPID:-$$}"

    case "${status}" in
        running)
            rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null || true
            touch "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}-running-${my_pid}-${ts}"
            ;;
        success)
            rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null || true
            rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null || true
            touch "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}-success-${ts}"
            ;;
        failed)
            rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null || true
            rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null || true
            touch "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}-failure-${exit_code}-${ts}"
            ;;
    esac
}

launch_background_install() {
    command -v tmux >/dev/null 2>&1 || die "后台模式需要 tmux，请先安装: apt-get install -y tmux"

    if tmux has-session -t "${TMUX_SESSION_NAME}" 2>/dev/null; then
        local finished_file
        finished_file="$(ls "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null | head -1)" || true
        if [[ -n "${finished_file}" ]]; then
            log_info "上次安装已完成，关闭旧 tmux 会话"
            tmux kill-session -t "${TMUX_SESSION_NAME}" 2>/dev/null || true
        else
            die "已有后台安装会话正在运行，使用 tmux attach -t ${TMUX_SESSION_NAME} 查看"
        fi
    fi

    local foreground_args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --background) ;;
            *) foreground_args+=("$1") ;;
        esac
        shift
    done

    mkdir -p "${INSTALL_STATUS_DIR}" 2>/dev/null || true
    write_install_status "running" 0

    # 方案A：安装结束后 tmux 会话立即退出，不再用 read -r 阻塞等待用户按键。
    # 失败信息可通过日志文件 / --status / .install-failure-* 状态文件查看。
    tmux new-session -d -s "${TMUX_SESSION_NAME}" -x 200 -y 50 \
        "_HERMES_BG_WORKER=1 bash '$0' ${foreground_args[*]+${foreground_args[*]}}"

    echo "后台安装已启动"
    echo "  查看实时日志: tmux attach -t ${TMUX_SESSION_NAME}"
    echo "  查看安装状态: $0 --status"
    echo "  日志文件: ${LOG_FILE:-/var/log/hermes-agent/}"
}

check_install_status() {
    if [[ -z "${_HERMES_BG_WORKER:-}" ]] && tmux has-session -t "${TMUX_SESSION_NAME}" 2>/dev/null; then
        local finished_file
        finished_file="$(ls "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null | head -1)" || true
        if [[ -n "${finished_file}" ]]; then
            log_info "上次安装已完成，关闭旧 tmux 会话"
            tmux kill-session -t "${TMUX_SESSION_NAME}" 2>/dev/null || true
        else
            # 兜底：tmux 会话存在，但 running 状态文件记录的 pid 已经不存在，
            # 说明上次后台安装已死亡（如 die 后退出），主动清理残留会话与状态文件
            local running_file basename_file name_without_prefix old_pid worker_alive=false
            running_file="$(ls "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null | head -1)" || true
            if [[ -n "${running_file}" ]]; then
                basename_file="$(basename "${running_file}")"
                name_without_prefix="${basename_file#${INSTALL_STATUS_PREFIX}-running-}"
                old_pid="${name_without_prefix%-*}"
                if [[ "${old_pid}" =~ ^[0-9]+$ ]] && kill -0 "${old_pid}" 2>/dev/null; then
                    worker_alive=true
                fi
            fi

            if [[ "${worker_alive}" == false ]]; then
                log_warn "检测到 tmux 会话残留但安装进程已退出，自动清理"
                tmux kill-session -t "${TMUX_SESSION_NAME}" 2>/dev/null || true
                rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null || true
            else
                log_info "检测到后台安装会话正在运行: tmux attach -t ${TMUX_SESSION_NAME}"
                return 1
            fi
        fi
    fi

    local running_file
    running_file="$(ls "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* 2>/dev/null | head -1)" || true

    if [[ -n "${running_file}" ]]; then
        local basename_file name_without_prefix old_pid
        basename_file="$(basename "${running_file}")"
        name_without_prefix="${basename_file#${INSTALL_STATUS_PREFIX}-running-}"
        old_pid="${name_without_prefix%-*}"

        if [[ "${old_pid}" =~ ^[0-9]+$ ]] && kill -0 "${old_pid}" 2>/dev/null; then
            log_warn "检测到安装进程正在运行 (pid=${old_pid})"
            return 1
        else
            log_warn "发现残留的 running 状态文件，但进程 ${old_pid} 已不存在，清理继续"
            rm -f "${running_file}"
        fi
    fi

    local last_status_file
    last_status_file="$(ls -t "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null | head -1)" || true

    if [[ -n "${last_status_file}" ]]; then
        local bn
        bn="$(basename "${last_status_file}")"
        if [[ "${bn}" == *-failure-* ]]; then
            log_warn "上次安装未成功: ${bn}"
        fi
    fi

    return 0
}

cleanup_install_status() {
    rm -f "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-* 2>/dev/null || true
}

show_install_status() {
    echo "Hermes 安装状态:"

    if tmux has-session -t "${TMUX_SESSION_NAME}" 2>/dev/null; then
        echo "  [进行中] tmux 会话: ${TMUX_SESSION_NAME}"
        echo "           使用 tmux attach -t ${TMUX_SESSION_NAME} 查看"
    fi

    local found=false
    for f in "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-running-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-success-* "${INSTALL_STATUS_DIR}/${INSTALL_STATUS_PREFIX}"-failure-*; do
        [[ -e "${f}" ]] || continue
        found=true
        local bn
        bn="$(basename "${f}")"
        if [[ "${bn}" == *-running-* ]]; then
            echo "  [进行中] ${bn}"
        elif [[ "${bn}" == *-success-* ]]; then
            echo "  [成功]   ${bn}"
        elif [[ "${bn}" == *-failure-* ]]; then
            echo "  [失败]   ${bn}"
        fi
    done
    if [[ "${found}" == false ]] && ! tmux has-session -t "${TMUX_SESSION_NAME}" 2>/dev/null; then
        echo "  无安装任务"
    fi
}

# ─── 日志初始化 ───────────────────────────────────────────────────────────────
init_logging() {
    RUN_TS="$(date '+%Y%m%d-%H%M%S')"
    LOG_DIR="${LOG_DIR:-/var/log/hermes-agent}"

    if ! mkdir -p "${LOG_DIR}" 2>/dev/null; then
        LOG_DIR="${TMPDIR:-/tmp}/hermes-agent"
        mkdir -p "${LOG_DIR}" || die "无法创建日志目录: ${LOG_DIR}"
    fi

    LOG_FILE="${LOG_DIR}/hermes-install-v2-${RUN_TS}.log"
    touch "${LOG_FILE}" || die "无法创建日志文件: ${LOG_FILE}"

    exec > >(tee -a "${LOG_FILE}") 2>&1
    log_info "日志文件: ${LOG_FILE}"
}

on_error() {
    local exit_code="$1" line_no="$2" command="$3"

    if [[ "${ROLLBACK_IN_PROGRESS}" == true ]]; then
        exit "${exit_code}"
    fi

    log_error "执行失败 (exit=${exit_code}, line=${line_no}): ${command}"

    write_install_status "failed" "${exit_code}"

    if [[ "${ROLLBACK_ARMED}" == true ]]; then
        rollback_upgrade
    fi
    exit "${exit_code}"
}

# ─── Docker 工具函数 ─────────────────────────────────────────────────────────
image_exists() {
    docker image inspect "$1" &>/dev/null
}

container_exists() {
    docker ps -a --format '{{.Names}}' | grep -qx "$1"
}

container_running() {
    docker ps --format '{{.Names}}' | grep -qx "$1"
}

check_json_file() {
    local json_file="$1"
    if command -v jq &>/dev/null; then
        jq -e '.' "${json_file}" >/dev/null 2>&1
    elif command -v python3 &>/dev/null; then
        python3 - "${json_file}" <<'PYEOF' >/dev/null
import json, sys
with open(sys.argv[1]) as f:
    json.load(f)
PYEOF
    else
        return 1
    fi
}

version_to_number() {
    local raw="$1"
    if [[ "${raw}" =~ ([0-9]{4})[.-]([0-9]{1,2})[.-]([0-9]{1,2}) ]]; then
        printf '%04d%02d%02d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    else
        return 1
    fi
}

# ─── 配置值选择 ───────────────────────────────────────────────────────────────
choose_value() {
    local cli_value="$1" env_value="$2" config_value="$3" default_value="$4" result_var="$5" source_var="$6"
    local chosen="" source=""

    if [[ -n "${cli_value}" ]]; then
        chosen="${cli_value}"
        source="cli"
    elif [[ -n "${env_value}" ]]; then
        chosen="${env_value}"
        source="env"
    elif [[ -n "${config_value}" ]]; then
        chosen="${config_value}"
        source="openclaw"
    else
        chosen="${default_value}"
        source="default"
    fi

    printf -v "${result_var}" '%s' "${chosen}"
    printf -v "${source_var}" '%s' "${source}"
}

# ─── 从 OpenClaw 配置读取模型信息 ────────────────────────────────────────────
read_openclaw_models() {
    local cfg="$1"
    if [[ ! -f "${cfg}" ]]; then
        return 1
    fi

    if command -v jq &>/dev/null; then
        local primary_val
        primary_val="$(jq -r '.agents.defaults.model.primary // empty' "${cfg}" 2>/dev/null)" || true
        if [[ -n "${primary_val}" && "${primary_val}" == */* ]]; then
            OC_PROVIDER="${primary_val%%/*}"
        else
            OC_PROVIDER="$(jq -r '.models.providers | keys[0] // empty' "${cfg}" 2>/dev/null)" || return 1
        fi
        if [[ -z "${OC_PROVIDER}" ]]; then
            return 1
        fi
        OC_BASE_URL="$(jq -r --arg p "${OC_PROVIDER}" '.models.providers[$p].baseUrl // empty' "${cfg}" 2>/dev/null)"
        OC_API_KEY="$(jq -r --arg p "${OC_PROVIDER}" '.models.providers[$p].apiKey // empty' "${cfg}" 2>/dev/null)"
        OC_DEFAULT_MODEL="$(jq -r --arg p "${OC_PROVIDER}" '.models.providers[$p].models[0].id // empty' "${cfg}" 2>/dev/null)"
        OC_MODEL_IDS="$(jq -r --arg p "${OC_PROVIDER}" '[.models.providers[$p].models[]?.id] | join(" ")' "${cfg}" 2>/dev/null)"
    elif command -v python3 &>/dev/null; then
        eval "$(python3 - "${cfg}" <<'PYEOF'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
ps = data.get('models', {}).get('providers', {})
if not ps:
    sys.exit(1)
primary = data.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', '')
if primary and '/' in primary:
    name = primary.split('/', 1)[0]
else:
    name = next((k for k in ps.keys() if k != 'hermes'), '')
if not name or name not in ps:
    sys.exit(1)
p = ps[name]
print(f'OC_PROVIDER={name!r}')
print(f'OC_BASE_URL={p.get("baseUrl", "")!r}')
print(f'OC_API_KEY={p.get("apiKey", "")!r}')
ms = p.get('models', [])
if ms:
    print(f'OC_DEFAULT_MODEL={ms[0].get("id", "")!r}')
    print(f'OC_MODEL_IDS={" ".join(m.get("id", "") for m in ms if m.get("id"))!r}')
PYEOF
)" || return 1
        if [[ -z "${OC_PROVIDER:-}" ]]; then
            return 1
        fi
    else
        return 1
    fi

    return 0
}

read_openclaw_primary_model() {
    local cfg="${OPENCLAW_CONFIG}"
    if [[ ! -f "${cfg}" ]]; then
        return 1
    fi

    if command -v jq &>/dev/null; then
        OC_PRIMARY_MODEL="$(jq -r '.agents.defaults.model.primary // empty' "${cfg}" 2>/dev/null)" || return 1
    elif command -v python3 &>/dev/null; then
        OC_PRIMARY_MODEL="$(python3 - "${cfg}" 2>/dev/null <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
print(d.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", ""))
PYEOF
)" || return 1
    else
        return 1
    fi

    [[ -n "${OC_PRIMARY_MODEL}" ]] || return 1
    return 0
}

provider_to_env_key() {
    case "$1" in
        anthropic)           echo "ANTHROPIC_API_KEY" ;;
        gemini|google)       echo "GEMINI_API_KEY" ;;
        openrouter)          echo "OPENROUTER_API_KEY" ;;
        nous-api)            echo "NOUS_API_KEY" ;;
        copilot)             echo "GITHUB_TOKEN" ;;
        zai)                 echo "GLM_API_KEY" ;;
        kimi-coding)         echo "KIMI_API_KEY" ;;
        minimax)             echo "MINIMAX_API_KEY" ;;
        minimax-cn)          echo "MINIMAX_CN_API_KEY" ;;
        huggingface)         echo "HF_TOKEN" ;;
        xiaomi)              echo "XIAOMI_API_KEY" ;;
        arcee)               echo "ARCEEAI_API_KEY" ;;
        kilocode)            echo "KILOCODE_API_KEY" ;;
        ai-gateway)          echo "AI_GATEWAY_API_KEY" ;;
        deepseek)            echo "DEEPSEEK_API_KEY" ;;
        volcengine|ark|auto|dashscope|custom|lmstudio|ollama|vllm|llamacpp)
                             echo "OPENAI_API_KEY" ;;
        *)                   echo "OPENAI_API_KEY" ;;
    esac
}

provider_to_base_url_env() {
    case "$1" in
        openrouter)          echo "OPENROUTER_BASE_URL" ;;
        minimax)             echo "MINIMAX_BASE_URL" ;;
        minimax-cn)          echo "MINIMAX_CN_BASE_URL" ;;
        deepseek)            echo "DEEPSEEK_BASE_URL" ;;
        dashscope)           echo "DASHSCOPE_BASE_URL" ;;
        volcengine|ark|auto) echo "OPENAI_BASE_URL" ;;
        custom|lmstudio|ollama|vllm|llamacpp)
                             echo "OPENAI_BASE_URL" ;;
        *)                   echo "OPENAI_BASE_URL" ;;
    esac
}

# ─── 插件目录收集 ─────────────────────────────────────────────────────────────
collect_plugin_dir_candidates() {
    PLUGIN_DIR_CANDIDATES=()

    local dir_name="" dir_path=""
    for dir_name in "${PLUGIN_DIR_NAME}" "${PLUGIN_LEGACY_DIR_NAME}"; do
        [[ -n "${dir_name}" ]] || continue
        dir_path="${OPENCLAW_EXTENSIONS_DIR}/${dir_name}"

        local exists=false existing=""
        for existing in "${PLUGIN_DIR_CANDIDATES[@]:-}"; do
            if [[ "${existing}" == "${dir_path}" ]]; then
                exists=true
                break
            fi
        done

        if [[ "${exists}" == false ]]; then
            PLUGIN_DIR_CANDIDATES+=("${dir_path}")
        fi
    done
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

# ─── 环境文件与配置 ───────────────────────────────────────────────────────────
write_env_file() {
    local env_file="${DATA_DIR}/.env"
    mkdir -p "${DATA_DIR}"

    {
        echo "HERMES_UID=0"
        echo "HERMES_GID=0"
        echo "HERMES_HOME=/opt/data"
        echo "ACP_TCP_PORT=${ACP_TCP_PORT}"
        echo "ACP_TCP_HOST=${ACP_TCP_HOST}"
        echo "GATEWAY_ALLOW_ALL_USERS=true"
        if [[ -n "${API_KEY}" ]]; then
            local api_env_key
            api_env_key="$(provider_to_env_key "${API_PROVIDER}")"
            echo "${api_env_key}=${API_KEY}"
            case "${API_PROVIDER}" in
                volcengine|ark|auto|dashscope|custom|lmstudio|ollama|vllm|llamacpp|deepseek|openrouter|minimax|minimax-cn)
                    if [[ "${api_env_key}" != "OPENAI_API_KEY" ]]; then
                        echo "OPENAI_API_KEY=${API_KEY}"
                    fi
                    ;;
            esac
        fi
        if [[ -n "${API_BASE_URL}" ]]; then
            local base_env
            base_env="$(provider_to_base_url_env "${API_PROVIDER}")"
            if [[ -n "${base_env}" ]]; then
                echo "${base_env}=${API_BASE_URL}"
                case "${API_PROVIDER}" in
                    volcengine|ark|auto|dashscope|custom|lmstudio|ollama|vllm|llamacpp|deepseek|openrouter|minimax|minimax-cn)
                        if [[ "${base_env}" != "OPENAI_BASE_URL" ]]; then
                            echo "OPENAI_BASE_URL=${API_BASE_URL}"
                        fi
                        ;;
                esac
            fi
        fi
    } > "${env_file}"

    chmod 600 "${env_file}"
    log_info "已生成容器环境文件: ${env_file}"
}

update_config_yaml() {
    local config_yaml="${DATA_DIR}/config.yaml"
    if [[ ! -f "${config_yaml}" ]]; then
        return 1
    fi

    log_info "更新 Hermes config.yaml"
    if [[ -n "${API_PROVIDER}" ]]; then
        sed -i "s|^\(\s*provider:\s*\).*|\1\"${API_PROVIDER}\"|" "${config_yaml}"
    fi
    if [[ -n "${DEFAULT_MODEL_VAL}" ]]; then
        sed -i "s|^\(\s*default:\s*\).*|\1\"${DEFAULT_MODEL_VAL}\"|" "${config_yaml}"
    fi
    if [[ -n "${API_BASE_URL}" ]]; then
        sed -i "s|^\(\s*base_url:\s*\).*|\1\"${API_BASE_URL}\"|" "${config_yaml}"
    fi
    log_info "config.yaml 已更新 (provider=${API_PROVIDER}, model=${DEFAULT_MODEL_VAL}, base_url=${API_BASE_URL:-默认})"
    return 0
}

# ─── 容器管理 ─────────────────────────────────────────────────────────────────
tcp_port_open() {
    (exec 3<>"/dev/tcp/127.0.0.1/${ACP_PORT}") >/dev/null 2>&1
}

gateway_start_logged() {
    docker logs --tail 200 "${CONTAINER_NAME}" 2>/dev/null | grep -Eq 'Hermes gateway started|Hermes Gateway Starting'
}

wait_for_container_ready() {
    log_info "等待容器就绪 (超时 ${HEALTH_CHECK_TIMEOUT}s)"

    local elapsed=0
    local gateway_logged=false
    while (( elapsed < HEALTH_CHECK_TIMEOUT )); do
        if ! container_running "${CONTAINER_NAME}"; then
            log_warn "容器 ${CONTAINER_NAME} 未处于运行状态"
            docker logs --tail 120 "${CONTAINER_NAME}" 2>/dev/null || true
            return 1
        fi

        local cli_ok=false port_ok=false
        docker exec "${CONTAINER_NAME}" hermes version &>/dev/null && cli_ok=true
        tcp_port_open && port_ok=true
        if gateway_start_logged; then
            gateway_logged=true
        fi

        if [[ "${port_ok}" == true && ( "${cli_ok}" == true || "${gateway_logged}" == true ) ]]; then
            echo ""
            log_info "健康检查通过: Hermes CLI 与 ACP 端口均已就绪"
            return 0
        fi

        sleep 2
        elapsed=$((elapsed + 2))
        echo -n "."
    done

    echo ""

    if [[ "${gateway_logged}" == true ]]; then
        log_warn "已观察到 Hermes gateway 启动日志，追加 ${HEALTH_CHECK_POST_START_GRACE}s 宽限等待端口就绪"
        local grace_elapsed=0
        while (( grace_elapsed < HEALTH_CHECK_POST_START_GRACE )); do
            if ! container_running "${CONTAINER_NAME}"; then
                log_warn "容器 ${CONTAINER_NAME} 在宽限期内退出"
                docker logs --tail 120 "${CONTAINER_NAME}" 2>/dev/null || true
                return 1
            fi

            if tcp_port_open; then
                echo ""
                log_info "宽限等待后端口就绪，健康检查通过"
                return 0
            fi

            sleep 2
            grace_elapsed=$((grace_elapsed + 2))
            echo -n "."
        done

        echo ""
    fi

    # 健康检查超时但容器仍在运行：按用户要求容忍此情形，标记为成功并提示用户后续排查。
    log_warn "健康检查超时，但容器仍在运行；按容忍策略判定为成功，请稍后通过 'docker logs -f ${CONTAINER_NAME}' 自行确认"
    docker logs --tail 120 "${CONTAINER_NAME}" 2>/dev/null || true
    if container_running "${CONTAINER_NAME}"; then
        return 0
    fi
    log_warn "容器在健康检查结束时已退出"
    return 1
}

start_container_from_image() {
    local image_ref="$1"
    local apply_runtime_config="${2:-true}"
    local preserve_existing_env="${3:-false}"

    if container_exists "${CONTAINER_NAME}"; then
        log_warn "容器 ${CONTAINER_NAME} 已存在，删除后重建"
        docker rm -f "${CONTAINER_NAME}" >/dev/null
    fi

    if [[ "${preserve_existing_env}" == true && -f "${DATA_DIR}/.env" ]]; then
        log_info "复用已有容器环境文件: ${DATA_DIR}/.env"
    else
        write_env_file
    fi

    log_info "使用镜像 ${image_ref} 启动容器"
    docker run -d \
        --name "${CONTAINER_NAME}" \
        --init \
        --restart unless-stopped \
        --user root \
        --network host \
        -e ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}" \
        -e ACP_TCP_PORT="${ACP_PORT}" \
        -e TZ=Asia/Shanghai \
        --env-file "${DATA_DIR}/.env" \
        --entrypoint "/opt/hermes/docker/entrypoint-acp.sh" \
        --security-opt no-new-privileges=true \
        --tmpfs /tmp:size=256M \
        -v "${DATA_DIR}:/opt/data" \
        --cpus="${CPU_LIMIT}" \
        --memory="${MEM_LIMIT}" \
        --log-driver json-file \
        --log-opt max-size=20m \
        --log-opt max-file=5 \
        "${image_ref}" >/dev/null

    wait_for_container_ready || return 1

    if [[ "${apply_runtime_config}" == true ]]; then
        if update_config_yaml; then
            log_info "重启容器以加载更新后的 config.yaml"
            docker restart "${CONTAINER_NAME}" >/dev/null
            wait_for_container_ready || return 1
        else
            log_info "config.yaml 尚未生成，沿用镜像默认配置"
        fi
    fi

    return 0
}

restart_openclaw_gateway() {
    local strict_mode="${1:-false}"
    local attempt=1

    while (( attempt <= OPENCLAW_GATEWAY_RESTART_RETRIES )); do
        log_info "重启 OpenClaw gateway 以加载插件 (attempt ${attempt}/${OPENCLAW_GATEWAY_RESTART_RETRIES})"

        if openclaw gateway restart >/dev/null 2>&1; then
            wait_for_openclaw_gateway
            log_info "OpenClaw gateway 重启完成"
            return 0
        fi

        if (( attempt < OPENCLAW_GATEWAY_RESTART_RETRIES )); then
            log_warn "OpenClaw gateway restart 执行失败，${OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP}s 后重试"
            sleep "${OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP}"
        fi
        attempt=$((attempt + 1))
    done

    if [[ "${strict_mode}" == "true" ]]; then
        log_error "OpenClaw gateway 多次重启失败"
        return 1
    fi

    log_warn "OpenClaw gateway 多次重启失败，但 Hermes 容器已完成部署；请稍后手动执行 'openclaw gateway restart'"
    return 0
}

openclaw_gateway_supports_status() {
    openclaw gateway --help 2>&1 | grep -Eq '(^|[[:space:]])status([[:space:]]|$)'
}

wait_for_openclaw_gateway() {
    local timeout="${OPENCLAW_GATEWAY_READY_TIMEOUT}"
    local fallback_sleep="${OPENCLAW_GATEWAY_FALLBACK_SLEEP}"

    if openclaw_gateway_supports_status; then
        log_info "等待 OpenClaw gateway 就绪 (超时 ${timeout}s)"
        local elapsed=0
        while (( elapsed < timeout )); do
            local status_output
            status_output="$(openclaw gateway status 2>&1 || true)"

            if [[ -n "${status_output}" ]] && ! grep -Eiq 'starting|stopped|down|error|fail|not[[:space:]-]*running|unavailable' <<<"${status_output}"; then
                echo ""
                log_info "OpenClaw gateway 已就绪: ${status_output//$'\n'/ }"
                return 0
            fi

            sleep 2
            elapsed=$((elapsed + 2))
            echo -n "."
        done

        echo ""
        log_warn "未在 ${timeout}s 内确认 OpenClaw gateway 就绪，执行保底等待 ${fallback_sleep}s"
    else
        log_warn "当前 OpenClaw 不支持 gateway status，执行保底等待 ${fallback_sleep}s"
    fi

    sleep "${fallback_sleep}"
    log_info "OpenClaw gateway 保底等待完成"
    return 0
}

# ─── 备份与回滚 ───────────────────────────────────────────────────────────────
backup_file() {
    local src="$1" dest="$2" label="$3"
    cp -a "${src}" "${dest}"
    log_info "已备份 ${label}: ${dest}"
}

backup_directory() {
    local src="$1" dest="$2" label="$3"
    cp -a "${src}" "${dest}"
    log_info "已备份 ${label}: ${dest}"
}

prepare_restore_point() {
    log_step "创建备份与回滚点"

    BACKUP_DIR="${DATA_DIR}/backups/${RUN_TS}"
    mkdir -p "${BACKUP_DIR}" || die "无法创建备份目录: ${BACKUP_DIR}"

    OPENCLAW_CONFIG_BACKUP="${BACKUP_DIR}/openclaw.json"
    backup_file "${OPENCLAW_CONFIG}" "${OPENCLAW_CONFIG_BACKUP}" "OpenClaw 配置"

    local config_yaml="${DATA_DIR}/config.yaml"
    if [[ -f "${config_yaml}" ]]; then
        HERMES_CONFIG_EXISTED=true
        HERMES_CONFIG_BACKUP="${BACKUP_DIR}/config.yaml"
        backup_file "${config_yaml}" "${HERMES_CONFIG_BACKUP}" "Hermes config.yaml"
    else
        log_info "未发现现有 ${config_yaml}，跳过该备份"
    fi

    local env_file="${DATA_DIR}/.env"
    if [[ -f "${env_file}" ]]; then
        ENV_FILE_EXISTED=true
        ENV_FILE_BACKUP="${BACKUP_DIR}/container.env"
        backup_file "${env_file}" "${ENV_FILE_BACKUP}" "Hermes 环境文件"
    else
        log_info "未发现现有 ${env_file}，回滚时将按当前配置重建"
    fi

    collect_plugin_dir_candidates
    PLUGIN_DIR_BACKUP="${BACKUP_DIR}/plugins"
    mkdir -p "${PLUGIN_DIR_BACKUP}"

    local plugin_dir="" plugin_backup_count=0
    for plugin_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
        if [[ -d "${plugin_dir}" ]]; then
            PLUGIN_DIR_EXISTED=true
            backup_directory "${plugin_dir}" "${PLUGIN_DIR_BACKUP}/$(basename "${plugin_dir}")" "Hermes 插件目录"
            plugin_backup_count=$((plugin_backup_count + 1))
        fi
    done
    if (( plugin_backup_count == 0 )); then
        log_info "未发现现有 Hermes 插件目录，回滚时按需要清理"
    fi

    if image_exists "${HERMES_IMAGE_NAME}:latest"; then
        PREVIOUS_IMAGE_PRESENT=true
        PREVIOUS_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_NAME}:latest")"
        ROLLBACK_IMAGE_TAG="${HERMES_IMAGE_NAME}:rollback-${RUN_TS}"
        docker tag "${HERMES_IMAGE_NAME}:latest" "${ROLLBACK_IMAGE_TAG}"
        log_info "已创建镜像回滚标签: ${ROLLBACK_IMAGE_TAG} (${PREVIOUS_IMAGE_ID})"
    else
        log_info "当前不存在 ${HERMES_IMAGE_NAME}:latest，将按全新部署流程继续"
    fi

    if container_exists "${CONTAINER_NAME}"; then
        PREVIOUS_CONTAINER_PRESENT=true
        if container_running "${CONTAINER_NAME}"; then
            PREVIOUS_CONTAINER_RUNNING=true
        fi
        log_info "检测到现有容器 ${CONTAINER_NAME} (running=${PREVIOUS_CONTAINER_RUNNING})"
    else
        log_info "当前不存在容器 ${CONTAINER_NAME}"
    fi

    ROLLBACK_ARMED=true
    log_info "自动回滚已启用，备份目录: ${BACKUP_DIR}"
}

restore_file_if_needed() {
    local backup_path="$1" target_path="$2" existed_flag="$3" label="$4"

    if [[ -n "${backup_path}" && -f "${backup_path}" ]]; then
        mkdir -p "$(dirname "${target_path}")"
        cp -a "${backup_path}" "${target_path}"
        log_info "已恢复 ${label}: ${target_path}"
    elif [[ "${existed_flag}" == false && -e "${target_path}" ]]; then
        rm -rf "${target_path}"
        log_info "已删除升级期间新增的 ${label}: ${target_path}"
    fi

    return 0
}

restore_plugin_directories() {
    collect_plugin_dir_candidates

    local plugin_dir=""
    for plugin_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
        if [[ -d "${plugin_dir}" ]]; then
            rm -rf "${plugin_dir}" 2>/dev/null || true
            log_info "已清理待恢复前的插件目录: ${plugin_dir}"
        fi
    done

    if [[ -n "${PLUGIN_DIR_BACKUP}" && -d "${PLUGIN_DIR_BACKUP}" ]]; then
        mkdir -p "${OPENCLAW_EXTENSIONS_DIR}"
        local backup_dir="" restored=false
        for backup_dir in "${PLUGIN_DIR_BACKUP}"/*; do
            [[ -d "${backup_dir}" ]] || continue
            cp -a "${backup_dir}" "${OPENCLAW_EXTENSIONS_DIR}/"
            log_info "已恢复插件目录: ${OPENCLAW_EXTENSIONS_DIR}/$(basename "${backup_dir}")"
            restored=true
        done

        if [[ "${restored}" == false ]]; then
            log_info "插件备份目录为空，跳过恢复"
        fi
    elif [[ "${PLUGIN_DIR_EXISTED}" == false ]]; then
        log_info "升级前不存在 Hermes 插件目录，已保持清理状态"
    fi

    return 0
}

rollback_upgrade() {
    trap - ERR
    ROLLBACK_IN_PROGRESS=true

    log_step "执行自动回滚"
    log_warn "开始恢复升级前状态，请勿中断脚本"

    local rollback_failed=false

    if container_exists "${CONTAINER_NAME}"; then
        docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || rollback_failed=true
    fi

    restore_file_if_needed "${OPENCLAW_CONFIG_BACKUP}" "${OPENCLAW_CONFIG}" true "OpenClaw 配置" || rollback_failed=true
    restore_plugin_directories || rollback_failed=true
    restore_file_if_needed "${HERMES_CONFIG_BACKUP}" "${DATA_DIR}/config.yaml" "${HERMES_CONFIG_EXISTED}" "Hermes config.yaml" || rollback_failed=true
    restore_file_if_needed "${ENV_FILE_BACKUP}" "${DATA_DIR}/.env" "${ENV_FILE_EXISTED}" "Hermes 环境文件" || rollback_failed=true

    if [[ "${PREVIOUS_IMAGE_PRESENT}" == true ]]; then
        if [[ -n "${ROLLBACK_IMAGE_TAG}" ]] && image_exists "${ROLLBACK_IMAGE_TAG}"; then
            docker tag "${ROLLBACK_IMAGE_TAG}" "${HERMES_IMAGE_NAME}:latest" 2>/dev/null || rollback_failed=true
            log_info "已恢复镜像标签: ${HERMES_IMAGE_NAME}:latest"
        fi
    fi

    if [[ "${PREVIOUS_CONTAINER_PRESENT}" == true ]]; then
        if image_exists "${HERMES_IMAGE_NAME}:latest"; then
            log_info "尝试恢复容器..."
            if start_container_from_image "${HERMES_IMAGE_NAME}:latest" true true; then
                log_info "容器已恢复并启动"
            else
                log_warn "容器恢复失败"
                rollback_failed=true
            fi
        fi
    fi

    if [[ "${rollback_failed}" == true ]]; then
        log_error "部分回滚步骤失败，请手动检查"
    else
        log_info "回滚完成"
    fi
}

cleanup_rollback_artifacts() {
    if [[ -n "${ROLLBACK_IMAGE_TAG}" ]] && image_exists "${ROLLBACK_IMAGE_TAG}"; then
        docker rmi "${ROLLBACK_IMAGE_TAG}" 2>/dev/null || true
        log_info "已清理回滚标签: ${ROLLBACK_IMAGE_TAG}"
    fi

    if [[ -n "${BACKUP_DIR}" && -d "${BACKUP_DIR}" ]]; then
        rm -rf "${BACKUP_DIR}"
        log_info "已清理备份目录: ${BACKUP_DIR}"
    fi
}

# ─── 阶段 1：环境检测 ─────────────────────────────────────────────────────────
phase1_check_env() {
    log_step "检查环境"

    command -v docker &>/dev/null || die "未找到 docker 命令"
    docker info &>/dev/null || die "Docker 未运行或当前用户无权限"

    DOCKER_ROOT_DIR="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo "/var/lib/docker")"
    log_info "Docker Root Dir: ${DOCKER_ROOT_DIR}"

    CPU_LIMIT="2"
    MEM_LIMIT="4g"

    invalidate_cached_plugin_archive
    check_openclaw_compatibility
    check_disk_space
}

invalidate_cached_plugin_archive() {
    local cached_plugin_tar="${CACHE_DIR}/hermes-plugin.tar.gz"
    if [[ -f "${cached_plugin_tar}" ]]; then
        rm -f "${cached_plugin_tar}"
        log_info "已清理旧插件缓存，强制重新下载: ${cached_plugin_tar}"
    else
        log_info "未发现旧插件缓存: ${cached_plugin_tar}"
    fi
}

check_disk_space() {
    log_step "检查磁盘空间"

    local min_free_kb=$(( MIN_FREE_SPACE_GB * 1024 * 1024 ))
    local -a paths=("/tmp" "${DATA_DIR}" "${DOCKER_ROOT_DIR}")
    local -A seen_mounts=()
    local path=""

    for path in "${paths[@]}"; do
        [[ -n "${path}" ]] || continue

        if [[ ! -e "${path}" ]]; then
            mkdir -p "${path}" || die "无法创建目录用于磁盘检查: ${path}"
        fi

        local df_output mount_point avail_kb avail_gb
        df_output="$(df -Pk "${path}" | awk 'NR==2 {print $4 " " $6}')"
        avail_kb="${df_output%% *}"
        mount_point="${df_output#* }"

        if [[ -n "${seen_mounts[${mount_point}]:-}" ]]; then
            continue
        fi
        seen_mounts["${mount_point}"]=1

        avail_gb="$(awk -v kb="${avail_kb}" 'BEGIN { printf "%.1f", kb / 1024 / 1024 }')"
        log_info "挂载点 ${mount_point} 可用空间: ${avail_gb}GB"

        if (( avail_kb < min_free_kb )); then
            die "挂载点 ${mount_point} 可用空间不足 ${MIN_FREE_SPACE_GB}GB，停止部署/升级"
        fi
    done
}

check_openclaw_compatibility() {
    log_step "检查 OpenClaw 兼容性"

    command -v openclaw &>/dev/null || die "未找到 openclaw 命令，无法继续升级"
    [[ -f "${OPENCLAW_CONFIG}" ]] || die "未找到 OpenClaw 配置文件: ${OPENCLAW_CONFIG}"
    check_json_file "${OPENCLAW_CONFIG}" || die "OpenClaw 配置文件不是有效 JSON: ${OPENCLAW_CONFIG}"

    local version_output version_num min_version_num
    version_output="$(openclaw --version 2>&1 | tr -d '\r')"
    [[ -n "${version_output}" ]] || die "无法读取 OpenClaw 版本"

    version_num="$(version_to_number "${version_output}")" || die "无法解析 OpenClaw 版本输出: ${version_output}"
    min_version_num="$(version_to_number "${MIN_OPENCLAW_VERSION}")" || die "无法解析最低 OpenClaw 版本要求: ${MIN_OPENCLAW_VERSION}"

    if (( version_num < min_version_num )); then
        die "OpenClaw 版本过低: ${version_output}，需要大于等于 ${MIN_OPENCLAW_VERSION}"
    fi
    log_info "OpenClaw 版本检查通过: ${version_output}"

}

# ─── 阶段 2：拉取镜像 ─────────────────────────────────────────────────────────
phase2_pull_image() {
    log_step "拉取 Hermes 镜像"

    PREVIOUS_IMAGE_ID=""
    if image_exists "${HERMES_IMAGE_NAME}:latest"; then
        PREVIOUS_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_NAME}:latest")"
        log_info "当前镜像 ID: ${PREVIOUS_IMAGE_ID}"

        if container_running "${CONTAINER_NAME}"; then
            log_info "停止旧容器以释放镜像引用: ${CONTAINER_NAME}"
            docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
        fi
        if container_exists "${CONTAINER_NAME}"; then
            log_info "删除旧容器以释放镜像引用: ${CONTAINER_NAME}"
            docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
        fi

        log_info "清理旧镜像释放磁盘空间: ${HERMES_IMAGE_NAME}:latest"
        docker rmi "${HERMES_IMAGE_NAME}:latest" 2>/dev/null || log_warn "旧镜像清理失败（可能仍被引用）"
    else
        log_info "当前不存在 ${HERMES_IMAGE_NAME}:latest，将拉取新镜像"
    fi

    log_info "拉取镜像: ${HERMES_DOCKER_IMAGE}"
    docker pull "${HERMES_DOCKER_IMAGE}"

    docker tag "${HERMES_DOCKER_IMAGE}" "${HERMES_IMAGE_NAME}:latest"

    if ! image_exists "${HERMES_IMAGE_NAME}:latest"; then
        die "镜像拉取后未找到 ${HERMES_IMAGE_NAME}:latest"
    fi

    local new_image_id
    new_image_id="$(docker image inspect --format '{{.Id}}' "${HERMES_IMAGE_NAME}:latest")"
    log_info "镜像就绪，ID: ${new_image_id}"

    if [[ -n "${PREVIOUS_IMAGE_ID}" ]]; then
        docker rmi "${PREVIOUS_IMAGE_ID}" 2>/dev/null || true
    fi
}

# ─── 阶段 3a：配置收集 ────────────────────────────────────────────────────────
phase3_collect_config() {
    log_step "读取配置"

    OC_PROVIDER="" OC_BASE_URL="" OC_API_KEY="" OC_DEFAULT_MODEL="" OC_MODEL_IDS=""
    OC_PRIMARY_MODEL=""
    local provider_source="" api_key_source="" model_source="" base_url_source=""

    if read_openclaw_models "${OPENCLAW_CONFIG}"; then
        log_info "从 OpenClaw 配置读取模型信息 (provider: ${OC_PROVIDER})"
        if [[ -n "${OC_MODEL_IDS}" ]]; then
            log_info "可用模型: ${OC_MODEL_IDS}"
        fi
    else
        log_warn "未从 OpenClaw 配置中读取到模型信息，将使用环境变量或默认值"
    fi

    if read_openclaw_primary_model; then
        log_info "从 OpenClaw agents 配置读取主模型: ${OC_PRIMARY_MODEL}"
    else
        log_info "未从 OpenClaw agents 配置读取到主模型"
    fi

    local oc_model_candidate="${OC_PRIMARY_MODEL:-${OC_DEFAULT_MODEL}}"
    if [[ -n "${oc_model_candidate}" && "${oc_model_candidate}" == */* ]]; then
        oc_model_candidate="${oc_model_candidate#*/}"
    fi

    choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "" "custom" API_PROVIDER provider_source
    choose_value "${CLI_API_KEY}" "${HERMES_API_KEY:-}" "${OC_API_KEY:-}" "" API_KEY api_key_source
    choose_value "${CLI_DEFAULT_MODEL}" "${HERMES_DEFAULT_MODEL:-}" "${oc_model_candidate:-}" "doubao-seed-2-0-pro-260215" DEFAULT_MODEL_VAL model_source
    choose_value "${CLI_API_BASE_URL}" "${HERMES_API_BASE_URL:-}" "${OC_BASE_URL:-}" "" API_BASE_URL base_url_source

    if [[ -z "${API_KEY}" ]]; then
        log_warn "未设置 API Key，Hermes 可能无法调用 LLM"
    else
        log_info "API Key: $(mask_secret "${API_KEY}") (source=${api_key_source})"
    fi
    log_info "Provider: ${API_PROVIDER} (source=${provider_source}) | Model: ${DEFAULT_MODEL_VAL} (source=${model_source})"
    if [[ -n "${API_BASE_URL}" ]]; then
        log_info "Base URL: ${API_BASE_URL} (source=${base_url_source})"
    else
        log_info "Base URL: 未显式设置 (source=${base_url_source})"
    fi
}

# ─── 阶段 3b：插件升级（卸载 + 安装） ─────────────────────────────────────────
phase3_upgrade_plugin() {
    log_step "升级插件"

    uninstall_hermes_plugin
    install_hermes_plugin
}

uninstall_hermes_plugin() {
    if ! command -v openclaw &>/dev/null; then
        log_warn "未找到 openclaw 命令，跳过卸载"
        return 0
    fi

    local plugin_installed=false
    if [[ -f "${OPENCLAW_CONFIG}" ]]; then
        if command -v jq &>/dev/null; then
            jq -e --arg pk "${PLUGIN_CONFIG_KEY}" --arg legacy_pk "hermes" \
              '.plugins.entries[$pk] != null or .plugins.entries[$legacy_pk] != null' \
              "${OPENCLAW_CONFIG}" >/dev/null 2>&1 && plugin_installed=true
        elif command -v python3 &>/dev/null; then
            python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" >/dev/null 2>&1 <<'PYEOF' && plugin_installed=true
import json, sys
cfg, pk = sys.argv[1], sys.argv[2]
with open(cfg) as f:
    data = json.load(f)
entries = data.get("plugins", {}).get("entries", {})
if pk in entries or "hermes" in entries:
    sys.exit(0)
sys.exit(1)
PYEOF
        fi
    fi

    if [[ -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}" || -d "${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}" ]]; then
        plugin_installed=true
    fi

    if [[ "${plugin_installed}" == false ]]; then
        log_info "未检测到旧版 Hermes 插件，跳过卸载"
        return 0
    fi

    log_info "卸载旧版插件: openclaw-plugin-hermes"
    local uninstall_output uninstall_exit
    uninstall_output="$(echo "y" | openclaw plugins uninstall openclaw-plugin-hermes 2>&1)" && uninstall_exit=0 || uninstall_exit=$?
    if [[ "${uninstall_exit}" -eq 0 ]]; then
        log_info "插件卸载成功"
    else
        log_warn "插件卸载失败或插件未安装 (exit=${uninstall_exit}): ${uninstall_output}"
    fi

    local plugin_dir="${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}"
    if [[ -d "${plugin_dir}" ]]; then
        rm -rf "${plugin_dir}"
        log_info "已清理残留插件目录: ${plugin_dir}"
    fi
    local legacy_dir="${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}"
    if [[ -d "${legacy_dir}" ]]; then
        rm -rf "${legacy_dir}"
        log_info "已清理残留旧版插件目录: ${legacy_dir}"
    fi

    if command -v openclaw &>/dev/null; then
        log_info "重启 OpenClaw gateway 以清理卸载后的插件状态"
        openclaw gateway restart >/dev/null 2>&1 || log_warn "gateway restart 失败，继续安装流程"
        wait_for_openclaw_gateway
    fi
}

RESOLVED_PLUGIN_PATH=""

resolve_plugin_tarball() {
    if [[ -n "${LOCAL_PLUGIN_DIR}" && -d "${LOCAL_PLUGIN_DIR}" && -f "${LOCAL_PLUGIN_DIR}/openclaw.plugin.json" ]]; then
        command -v npm >/dev/null 2>&1 || die "缺少 npm，无法打包本地插件"
        command -v python3 >/dev/null 2>&1 || die "缺少 python3，无法解析 npm pack 输出"
        local tmp_dir pack_output packed_name packed_tar
        tmp_dir="$(mktemp -d)"
        register_temp "${tmp_dir}"
        pack_output="$(cd "${LOCAL_PLUGIN_DIR}" && npm pack --pack-destination "${tmp_dir}" --json 2>/dev/null)"
        packed_name="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[0]["filename"])' <<<"${pack_output}")"
        packed_tar="${tmp_dir}/${packed_name}"
        log_info "本地插件包: ${packed_tar}"
        RESOLVED_PLUGIN_PATH="${packed_tar}"
        return 0
    fi

    local tmp_dir plugin_tar
    tmp_dir="$(mktemp -d)"
    register_temp "${tmp_dir}"
    plugin_tar="${tmp_dir}/openclaw-plugin-hermes-${PLUGIN_VERSION}.tgz"
    log_info "下载插件: ${PUBLIC_PLUGIN_URL}"
    curl -fsSL "${PUBLIC_PLUGIN_URL}" -o "${plugin_tar}"

    if [[ ! -s "${plugin_tar}" ]]; then
        die "插件包下载失败或文件为空: ${PUBLIC_PLUGIN_URL}"
    fi
    local file_type
    file_type="$(file -b "${plugin_tar}" 2>/dev/null || echo "unknown")"
    if [[ "${file_type}" != *gzip* && "${file_type}" != *tar* ]]; then
        log_error "下载的文件不是有效的 tgz 包 (file type: ${file_type})"
        log_error "文件前 200 字节:"
        head -c 200 "${plugin_tar}" | cat -v || true
        echo ""
        die "插件包格式异常: ${PUBLIC_PLUGIN_URL}"
    fi
    log_info "插件包下载完成: ${plugin_tar} ($(wc -c < "${plugin_tar}") bytes, ${file_type})"

    RESOLVED_PLUGIN_PATH="${plugin_tar}"
}

install_hermes_plugin() {
    RESOLVED_PLUGIN_PATH=""
    resolve_plugin_tarball

    if [[ -z "${RESOLVED_PLUGIN_PATH}" ]]; then
        die "未能解析插件包路径"
    fi

    log_info "执行 openclaw plugins install ${RESOLVED_PLUGIN_PATH} --dangerously-force-unsafe-install"
    if ! openclaw plugins install "${RESOLVED_PLUGIN_PATH}" --dangerously-force-unsafe-install; then
        die "插件安装失败 (openclaw plugins install ${RESOLVED_PLUGIN_PATH})"
    fi
    log_info "插件安装完成"

    update_config_yaml || log_info "config.yaml 尚未生成，将在容器首次启动后由 entrypoint 创建"
}

# ─── 阶段 4：启动容器 ─────────────────────────────────────────────────────────
phase4_start_container() {
    log_step "启动容器"

    if ! start_container_from_image "${HERMES_IMAGE_NAME}:latest" true false; then
        die "新版本容器启动失败或健康检查未通过"
    fi

    restart_openclaw_gateway
}

# ─── 阶段 5：归一化 openclaw.json 配置 ────────────────────────────────────────
normalize_runtime_entries() {
    [[ -f "${OPENCLAW_CONFIG}" ]] || return 0

    log_info "补齐 Hermes runtime 配置归一化"
    local config_dir
    config_dir="$(dirname "${OPENCLAW_CONFIG}")"

    if command -v jq >/dev/null 2>&1; then
        local tmp default_model
        tmp="$(mktemp "${config_dir}/openclaw.json.tmp.XXXXXX")"
        register_temp "${tmp}"
        default_model="$(jq -r --arg pk "${PLUGIN_CONFIG_KEY}" '.plugins.entries[$pk].config.defaultModel // "doubao-seed-2-0-pro-260215"' "${OPENCLAW_CONFIG}" 2>/dev/null)"

        jq \
          --arg pk "${PLUGIN_CONFIG_KEY}" \
          --arg legacy_pk "hermes" \
          --arg oe "http://localhost:4318" \
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
              "otel": {
                   "endpoint": $oe
               },
              "skillProjection": {
                "hostBackedDenylist": (((($cfg.skillProjection.hostBackedDenylist // []) + ["browser", "browser-use", "feishu"]) | unique)),
                "hostBackedSkillNames": (((($cfg.skillProjection.hostBackedSkillNames // []) + ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use"]) | unique)),
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
          | .agents.defaults.models = ((.agents.defaults.models // {}) + {
              "hermes/default": { "alias": "hermes" }
            })
          | .models = (.models // {})
          | .models.providers = (.models.providers // {})
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
          ' "${OPENCLAW_CONFIG}" > "${tmp}" || die "OpenClaw 配置归一化失败: jq 写入失败"
        mv "${tmp}" "${OPENCLAW_CONFIG}"
    elif command -v python3 >/dev/null 2>&1; then
        local tmp
        tmp="$(mktemp "${config_dir}/openclaw.json.tmp.XXXXXX")"
        register_temp "${tmp}"
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
        "hostBackedSkillNames": unique(skill_cfg.get("hostBackedSkillNames", []) + ["lark-doc", "lark-calendar", "lark-im", "lark-sheets", "lark-base", "lark-drive", "lark-task", "lark-mail", "feishu", "browser", "browser-use"]),
        "containerEnvSkillNames": unique(skill_cfg.get("containerEnvSkillNames", [])),
        "alwaysExposeSkillNames": unique(skill_cfg.get("alwaysExposeSkillNames", []) + ["browser-use", "computer-use", "byted-web-search", "web_search", "opencli", "byted-seedream-image-generate", "byted-seedance-video-generate", "arkdrive-netdisk"]),
    },
    "mcpBridge": {
        "enabled": True,
        "servers": mcp_cfg.get("servers", {}) if isinstance(mcp_cfg.get("servers"), dict) else {},
        "env": mcp_cfg.get("env", {}) if isinstance(mcp_cfg.get("env"), dict) else {},
    },
    "otel": {
        "endpoint": "http://localhost:4318",
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
with open(tmp, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
        mv "${tmp}" "${OPENCLAW_CONFIG}"
    else
        die "缺少 jq 或 python3，无法归一化 OpenClaw 配置"
    fi

    log_info "配置归一化完成"
}

# ─── MCP bridge SDK helper 补齐 ──────────────────────────────────────────────
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

    local openclaw_bin openclaw_real openclaw_dist runtime_js runtime_dts package_json
    openclaw_bin="$(command -v openclaw || true)"
    [[ -n "${openclaw_bin}" ]] || die "未找到 openclaw CLI，无法补齐 OpenClaw MCP bridge SDK helper"
    openclaw_real="$(readlink -f "${openclaw_bin}" 2>/dev/null || realpath "${openclaw_bin}" 2>/dev/null || printf '%s\n' "${openclaw_bin}")"
    openclaw_dist=""
    for candidate in \
        "$(dirname "${openclaw_real}")/../lib/node_modules/openclaw/dist" \
        "$(dirname "${openclaw_real}")/../node_modules/openclaw/dist" \
        "$(dirname "$(dirname "${openclaw_real}")")/lib/node_modules/openclaw/dist" \
        "/usr/lib/node_modules/openclaw/dist" \
        "/usr/local/lib/node_modules/openclaw/dist"
    do
        if [[ -d "${candidate}" && -f "$(dirname "${candidate}")/package.json" ]]; then
            openclaw_dist="$(cd "${candidate}" && pwd)"
            break
        fi
    done
    [[ -n "${openclaw_dist}" ]] || die "无法定位 OpenClaw dist 目录，无法补齐 MCP bridge SDK helper"

    runtime_js="${openclaw_dist}/plugin-sdk/agent-harness-runtime.js"
    runtime_dts="${openclaw_dist}/plugin-sdk/agent-harness-runtime.d.ts"
    package_json="$(dirname "${openclaw_dist}")/package.json"
    [[ -f "${package_json}" ]] || die "OpenClaw package.json 不存在: ${package_json}"

    log_info "补齐 OpenClaw MCP bridge SDK helper: ${runtime_js}"
    mkdir -p "$(dirname "${runtime_js}")"
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
    if ! RUNTIME_JS="${runtime_js}" node <<'NODE' >/dev/null 2>&1
const { pathToFileURL } = require("node:url");
(async () => {
  const mod = await import(pathToFileURL(process.env.RUNTIME_JS).href);
  process.exit(typeof mod.prepareAgentHarnessMcpBridge === "function" ? 0 : 1);
})();
NODE
    then
        die "OpenClaw MCP bridge SDK helper 补齐后校验失败"
    fi
    log_info "OpenClaw MCP bridge SDK helper 已补齐"
}

# ─── 阶段 6：部署摘要 ─────────────────────────────────────────────────────────
phase6_summary() {
    echo ""
    echo -e "${GREEN}  Hermes Agent v2 部署/升级完成${NC}"
    echo ""
    local status
    status="$(docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Status}}' 2>/dev/null || echo "未知")"
    echo -e "  容器: ${CYAN}${CONTAINER_NAME} (${status})${NC}"
    echo -e "  镜像: ${CYAN}${HERMES_DOCKER_IMAGE}${NC}"
    echo -e "  端口: ${CYAN}${ACP_PORT}${NC}"
    echo -e "  模型: ${CYAN}${API_PROVIDER}/${DEFAULT_MODEL_VAL}${NC}"
    echo -e "  数据: ${CYAN}${DATA_DIR}${NC}"
    echo -e "  备份: ${CYAN}${BACKUP_DIR}${NC}"
    echo -e "  日志: ${CYAN}${LOG_FILE}${NC}"
    echo ""
    echo "  常用命令:"
    echo "    docker logs -f ${CONTAINER_NAME}"
    echo "    docker exec ${CONTAINER_NAME} hermes version"
    echo "    docker exec -it ${CONTAINER_NAME} bash"
    echo ""
}

# ─── 清理（通过 --cleanup 参数调用） ─────────────────────────────────────────
do_cleanup() {
    log_step "清理"

    if container_exists "${CONTAINER_NAME}"; then
        docker rm -f "${CONTAINER_NAME}"
        log_info "容器已删除"
    else
        log_info "容器不存在，跳过"
    fi

    if command -v openclaw &>/dev/null; then
        log_info "卸载插件: openclaw-plugin-hermes"
        echo "y" | openclaw plugins uninstall openclaw-plugin-hermes 2>/dev/null || log_warn "插件卸载失败"
    fi

    collect_plugin_dir_candidates
    local plugin_dir=""
    for plugin_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
        if [[ -d "${plugin_dir}" ]]; then
            rm -rf "${plugin_dir}"
            log_info "已删除插件目录: ${plugin_dir}"
        fi
    done

    if [[ -f "${OPENCLAW_CONFIG}" ]]; then
        if command -v jq &>/dev/null; then
            local tmp
            tmp="$(mktemp)"
            jq --arg pk "${PLUGIN_CONFIG_KEY}" --arg legacy_pk "hermes" '
                del(.plugins.entries[$pk])
                | del(.plugins.entries[$legacy_pk])
                | .plugins.allow = ((.plugins.allow // []) | map(select(. != $pk and . != $legacy_pk)))
                | del(.models.providers.hermes)
                | del(.agents.defaults.models["hermes/default"])
                | del(.agents.defaults.models["hermes"])
                | del(.agents.defaults.agentRuntime)
                | del(.agents.defaults.model)
            ' "${OPENCLAW_CONFIG}" > "${tmp}" && mv "${tmp}" "${OPENCLAW_CONFIG}"
        elif command -v python3 &>/dev/null; then
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
defaults = data.get("agents", {}).get("defaults", {})
defaults.pop("agentRuntime", None)
defaults.pop("model", None)
allow = data.get("plugins", {}).get("allow", [])
data.setdefault("plugins", {})["allow"] = [item for item in allow if item not in (pk, "hermes")]
with open(cf, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
        fi
        log_info "已从 OpenClaw 配置移除 Hermes 相关条目"
    fi

    if image_exists "${HERMES_IMAGE_NAME}:latest"; then
        docker rmi "${HERMES_IMAGE_NAME}:latest" 2>/dev/null || log_warn "镜像删除失败"
        log_info "已删除镜像: ${HERMES_IMAGE_NAME}:latest"
    fi

    log_info "清理完成（数据目录 ${DATA_DIR} 已保留）"
}

# ─── 入口 ────────────────────────────────────────────────────────────────────
main() {
    init_logging
    trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
    parse_args "$@"

    ACP_TCP_PORT="$(normalize_port "ACP_TCP_PORT" "${ACP_TCP_PORT}")"
    ACP_PORT="${ACP_TCP_PORT}"

    if [[ "${CLEANUP_REQUESTED}" == true ]]; then
        do_cleanup
        exit 0
    fi

    # 启动时清理上一次的成功/失败状态文件，避免历史状态干扰本次安装
    # 注意：running 文件是并发锁，由 check_install_status 根据 PID 是否存活来判断处理，不在这里删除
    cleanup_install_status

    if [[ "${BACKGROUND_MODE}" == true ]]; then
        launch_background_install "$@"
        exit 0
    fi

    check_install_status || die "已有安装进程正在运行，请等待完成或使用 --status 查看"

    write_install_status "running" 0

    echo -e "${CYAN}  Hermes Agent v2 部署 / 安全升级${NC}"
    echo ""

    # 执行清理，但是保留数据目录
    # 1. 清理之前安装的残留：清空 /var/cache/hermes-agent 目录下所有文件（保留 .install-* 状态文件）
    if [[ -d "${CACHE_DIR}" ]]; then
        for f in "${CACHE_DIR}"/*; do
            [[ -e "${f}" ]] && rm -rf "${f}"
        done
        for f in "${CACHE_DIR}"/.[!.]*; do
            [[ -e "${f}" ]] || continue
            case "$(basename "${f}")" in
                .install-*) ;;
                *) rm -rf "${f}" ;;
            esac
        done
        log_info "已清理上次安装缓存目录: ${CACHE_DIR}"
    fi

    # 2. 备份原来 docker 容器里的文件到宿主机数据目录
    if container_running "${CONTAINER_NAME}"; then
        local backup_dir="${DATA_DIR}/bak"
        mkdir -p "${backup_dir}"
        log_info "备份容器 ${CONTAINER_NAME} 内 /root 目录到 ${backup_dir}"
        docker exec "${CONTAINER_NAME}" bash -c \
            'tar cf - -C /root . 2>/dev/null' | tar xf - -C "${backup_dir}" 2>/dev/null || \
            log_warn "容器内文件备份失败（非致命），继续安装"
    fi

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    phase1_check_env

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    detect_existing_installation

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    prepare_restore_point

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    phase2_pull_image

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    phase3_collect_config

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    phase3_upgrade_plugin

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    phase4_start_container

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    normalize_runtime_entries

    [[ "${BACKGROUND_MODE}" == true ]] && write_install_status "running" 0
    patch_openclaw_runtime_for_hermes_toolset

    ROLLBACK_ARMED=false
    cleanup_rollback_artifacts

    write_install_status "success" 0

    phase6_summary
}

main "$@"

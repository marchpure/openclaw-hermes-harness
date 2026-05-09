#!/usr/bin/env bash
# Hermes Agent 一键部署/升级脚本
# 用法: curl -fsSL <URL>/hermes.sh | bash
# 或:   ./hermes.sh [--cleanup]
# 或:   ./hermes.sh --api-key xxx --provider ark --model doubao-seed-code --base-url https://...

set -Eeuo pipefail

# ─── 地域检测 ──────────────────────────────────────────────────────────────────
HERMES_REGION="${HERMES_REGION:-}"
if [[ -z "${HERMES_REGION}" ]]; then
    HERMES_REGION=$(curl --connect-timeout 5 --max-time 10 -s "http://100.96.0.96/latest/region_id" || echo "")
fi
if [[ -z "${HERMES_REGION}" ]]; then
    HERMES_REGION="cn-beijing"
fi

# ─── 配置 ────────────────────────────────────────────────────────────────────
TOS_IMAGE_URL="${TOS_IMAGE_URL:-https://scarif-${HERMES_REGION}.tos-${HERMES_REGION}.ivolces.com/arkclaw/hermes/hermes-image/hermes-agent-image.tar.gz}"
TOS_PLUGIN_URL="${TOS_PLUGIN_URL:-https://scarif-${HERMES_REGION}.tos-${HERMES_REGION}.ivolces.com/arkclaw/hermes/hermes-plugin/openclaw-plugin-hermes.tar.gz}"
CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
ACP_PORT="${ACP_PORT:-3100}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-180}"
HEALTH_CHECK_POST_START_GRACE="${HEALTH_CHECK_POST_START_GRACE:-20}"
MIN_FREE_SPACE_GB="${MIN_FREE_SPACE_GB:-7}"
MIN_OPENCLAW_VERSION="${MIN_OPENCLAW_VERSION:-2026.3.28}"
OPENCLAW_GATEWAY_READY_TIMEOUT="${OPENCLAW_GATEWAY_READY_TIMEOUT:-30}"
OPENCLAW_GATEWAY_FALLBACK_SLEEP="${OPENCLAW_GATEWAY_FALLBACK_SLEEP:-5}"
OPENCLAW_GATEWAY_RESTART_RETRIES="${OPENCLAW_GATEWAY_RESTART_RETRIES:-3}"
OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP="${OPENCLAW_GATEWAY_RESTART_RETRY_SLEEP:-5}"
DOWNLOAD_CACHE_DIR="${DOWNLOAD_CACHE_DIR:-/var/cache/hermes-agent}"
FORCE_REDOWNLOAD="${FORCE_REDOWNLOAD:-false}"

# ─── 运行时变量 ──────────────────────────────────────────────────────────────
API_KEY=""
API_PROVIDER=""
DEFAULT_MODEL_VAL=""
API_BASE_URL=""
CPU_LIMIT=""
MEM_LIMIT=""
DOCKER_ROOT_DIR=""
CACHE_DIR=""
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
PLUGIN_DIR_BACKUP=""

declare -a PLUGIN_DIR_CANDIDATES=()

# ─── 颜色（自动检测 TTY，管道模式下禁用颜色） ────────────────────────────────
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
    if [[ "${ROLLBACK_ARMED:-false}" == true && "${ROLLBACK_IN_PROGRESS:-false}" != true ]]; then
        rollback_upgrade
    fi
    exit 1
}

# ─── 临时文件清理 trap ────────────────────────────────────────────────────────
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

usage() {
    cat <<'EOF'
Hermes Agent 一键部署 / 安全升级脚本

选项:
  --cleanup, --clean, --uninstall   执行清理流程
  --api-key <value>                 显式指定 API Key
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

parse_args() {
    CLEANUP_REQUESTED=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --cleanup|--clean|--uninstall)
                CLEANUP_REQUESTED=true
                ;;
            --api-key)
                shift
                require_arg_value "--api-key" "${1:-}"
                CLI_API_KEY="$1"
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
}

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

init_logging() {
    RUN_TS="$(date '+%Y%m%d-%H%M%S')"
    LOG_DIR="${LOG_DIR:-/var/log/hermes-agent}"

    if ! mkdir -p "${LOG_DIR}" 2>/dev/null; then
        LOG_DIR="${TMPDIR:-/tmp}/hermes-agent"
        mkdir -p "${LOG_DIR}" || die "无法创建日志目录: ${LOG_DIR}"
    fi

    LOG_FILE="${LOG_DIR}/upgrade-${RUN_TS}.log"
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
    if [[ "${ROLLBACK_ARMED}" == true ]]; then
        rollback_upgrade
    fi
    exit "${exit_code}"
}

# ─── 公共下载函数，避免 curl/wget 判断重复 ───────────────────────────────────
# 参数: $1=URL $2=输出文件路径
download_file() {
    local url="$1" dest="$2"

    if [[ "${FORCE_REDOWNLOAD}" != "true" && -s "${dest}" ]]; then
        log_info "复用已下载文件: ${dest} ($(du -h "${dest}" | awk '{print $1}'))"
        return 0
    fi

    if command -v curl &>/dev/null; then
        curl -fSL -o "${dest}" "${url}"
    elif command -v wget &>/dev/null; then
        wget -q -O "${dest}" "${url}"
    else
        die "需要 curl 或 wget 来下载文件"
    fi

    if [[ ! -s "${dest}" ]]; then
        die "下载失败: ${url}"
    fi

    log_info "下载完成: ${dest} ($(du -h "${dest}" | awk '{print $1}'))"
}

init_cache_dir() {
    CACHE_DIR="${DOWNLOAD_CACHE_DIR}"
    if ! mkdir -p "${CACHE_DIR}" 2>/dev/null; then
        CACHE_DIR="${TMPDIR:-/tmp}/hermes-agent-cache"
        mkdir -p "${CACHE_DIR}" || die "无法创建下载缓存目录: ${CACHE_DIR}"
    fi

    log_info "下载缓存目录: ${CACHE_DIR}"
    if [[ "${FORCE_REDOWNLOAD}" == "true" ]]; then
        log_warn "已启用强制重新下载，缓存文件将被覆盖"
    fi
}

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

    # 2026.4.8 版本的 --help 输出格式异常，grep 无法匹配子命令关键词，但命令实际可用，更高版本已修复
    local skip_help_check_version
    skip_help_check_version="$(version_to_number "2026.4.8")" || skip_help_check_version=99999999
    if (( version_num == skip_help_check_version )); then
        log_info "OpenClaw ${version_output} 为 2026.4.8，跳过 --help 子命令探测（该版本 --help 输出格式不包含子命令关键词，但命令实际可用）"
    else
        if ! openclaw plugins --help 2>&1 | grep -Eq '(^|[[:space:]])install([[:space:]]|$)'; then
            die "当前 OpenClaw 不支持 plugins install，无法升级插件"
        fi
        if ! openclaw gateway --help 2>&1 | grep -Eq '(^|[[:space:]])restart([[:space:]]|$)'; then
            die "当前 OpenClaw 不支持 gateway restart，无法自动重载插件"
        fi
        log_info "OpenClaw 能力探测通过 (plugins install / gateway restart)"
    fi
}

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

remove_installed_plugin_directories() {
    collect_plugin_dir_candidates

    local plugin_dir=""
    for plugin_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
        if [[ -d "${plugin_dir}" ]]; then
            rm -rf "${plugin_dir}"
            log_info "已删除已安装插件目录: ${plugin_dir}"
        fi
    done
}

# ─── 从 OpenClaw 配置读取模型信息 ────────────────────────────────────────────
# 结构: models.providers.<provider> = { baseUrl, apiKey, models: [{id}] }
# 注意:
# - 安装完成后会向 OpenClaw 注入一个合成 provider: models.providers.hermes
# - 这个 provider 只是 OpenClaw -> Hermes runtime 的本地桥接壳，不是真实上游 LLM
# - 二次安装/升级时必须跳过它，否则会把 http://127.0.0.1/hermes-runtime
#   误当成 Hermes 容器自己的上游模型地址，导致 LLM request failed: network connection error
read_openclaw_models() {
    local cfg="$1"
    if [[ ! -f "${cfg}" ]]; then
        return 1
    fi

    if command -v jq &>/dev/null; then
        OC_PROVIDER="$(jq -r '
          .models.providers
          | to_entries
          | map(select(.key != "hermes"))
          | .[0].key // empty
        ' "${cfg}" 2>/dev/null)" || return 1
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
name = next((k for k in ps.keys() if k != 'hermes'), '')
if not name:
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
        openai)         echo "OPENAI_API_KEY" ;;
        anthropic)      echo "ANTHROPIC_API_KEY" ;;
        google|gemini)  echo "GEMINI_API_KEY" ;;
        openrouter)     echo "OPENROUTER_API_KEY" ;;
        minimax)        echo "MINIMAX_API_KEY" ;;
        volcengine|ark) echo "ARK_API_KEY" ;;
        *)              echo "${1^^}_API_KEY" ;;
    esac
}

provider_to_base_url_env() {
    case "$1" in
        openai)         echo "OPENAI_BASE_URL" ;;
        minimax)        echo "MINIMAX_BASE_URL" ;;
        openrouter)     echo "OPENROUTER_BASE_URL" ;;
        volcengine|ark) echo "ARK_BASE_URL" ;;
        *)              echo "" ;;
    esac
}

update_config_yaml() {
    local config_yaml="${DATA_DIR}/config.yaml"
    if [[ ! -f "${config_yaml}" ]]; then
        return 1
    fi

    log_info "更新 Hermes config.yaml"
    if [[ -n "${DEFAULT_MODEL_VAL}" ]]; then
        sed -i "s|^\(\s*default:\s*\).*|\1\"${DEFAULT_MODEL_VAL}\"|" "${config_yaml}"
    fi
    if [[ -n "${API_BASE_URL}" ]]; then
        sed -i "s|^\(\s*base_url:\s*\).*|\1\"${API_BASE_URL}\"|" "${config_yaml}"
    fi
    log_info "config.yaml 已更新 (model=${DEFAULT_MODEL_VAL}, base_url=${API_BASE_URL:-默认})"
    return 0
}

write_env_file() {
    local env_file="${DATA_DIR}/.env"
    mkdir -p "${DATA_DIR}"

    {
        echo "HERMES_UID=0"
        echo "HERMES_GID=0"
        echo "HERMES_HOME=/opt/data"
        echo "ACP_TCP_PORT=3100"
        echo "ACP_TCP_HOST=0.0.0.0"
        echo "GATEWAY_ALLOW_ALL_USERS=true"
        if [[ -n "${API_KEY}" ]]; then
            local api_env_key
            api_env_key="$(provider_to_env_key "${API_PROVIDER}")"
            echo "${api_env_key}=${API_KEY}"
            if [[ "${api_env_key}" != "OPENAI_API_KEY" ]]; then
                echo "OPENAI_API_KEY=${API_KEY}"
            fi
        fi
        if [[ -n "${API_BASE_URL}" ]]; then
            local base_env
            base_env="$(provider_to_base_url_env "${API_PROVIDER}")"
            if [[ -n "${base_env}" ]]; then
                echo "${base_env}=${API_BASE_URL}"
                if [[ "${base_env}" != "OPENAI_BASE_URL" ]]; then
                    echo "OPENAI_BASE_URL=${API_BASE_URL}"
                fi
            fi
        fi
    } > "${env_file}"

    chmod 600 "${env_file}"
    log_info "已生成容器环境文件: ${env_file}"
}

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

    log_warn "健康检查超时，输出最近容器日志"
    docker logs --tail 120 "${CONTAINER_NAME}" 2>/dev/null || true
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
        -e TZ=Asia/Shanghai \
        --env-file "${DATA_DIR}/.env" \
        --entrypoint "/opt/hermes/docker/entrypoint-acp.sh" \
        --security-opt no-new-privileges=true \
        --tmpfs /tmp:size=256M \
        -v "${DATA_DIR}:/opt/data" \
        -p "127.0.0.1:${ACP_PORT}:3100" \
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
            docker tag "${ROLLBACK_IMAGE_TAG}" "${HERMES_IMAGE_NAME}:latest" >/dev/null 2>&1 || rollback_failed=true
            log_info "已恢复镜像标签 ${HERMES_IMAGE_NAME}:latest"
        else
            log_error "未找到镜像回滚标签 ${ROLLBACK_IMAGE_TAG}"
            rollback_failed=true
        fi
    fi

    if [[ "${PREVIOUS_CONTAINER_PRESENT}" == true ]]; then
        if [[ -n "${ROLLBACK_IMAGE_TAG}" ]] && image_exists "${ROLLBACK_IMAGE_TAG}"; then
            if ! start_container_from_image "${ROLLBACK_IMAGE_TAG}" false true; then
                log_error "旧版本容器回滚启动失败"
                rollback_failed=true
            fi
        else
            log_error "缺少旧版本镜像，无法恢复容器"
            rollback_failed=true
        fi
    fi

    if command -v openclaw &>/dev/null; then
        restart_openclaw_gateway false || true
    fi

    if [[ "${rollback_failed}" == true ]]; then
        log_error "自动回滚未完全成功，请重点检查日志: ${LOG_FILE}"
    else
        log_warn "自动回滚完成，系统已恢复到升级前状态"
    fi
}

cleanup_rollback_artifacts() {
    if [[ -n "${ROLLBACK_IMAGE_TAG}" ]] && image_exists "${ROLLBACK_IMAGE_TAG}"; then
        docker rmi "${ROLLBACK_IMAGE_TAG}" >/dev/null 2>&1 || true
        log_info "已清理临时回滚镜像标签: ${ROLLBACK_IMAGE_TAG}"
    fi
}

# ─── 阶段 1：环境检测 ────────────────────────────────────────────────────────
phase1_check_env() {
    log_step "环境检测"

    if [[ "$(uname -s)" != "Linux" ]]; then
        die "仅支持 Linux"
    fi
    log_info "系统: $(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'"' -f2 || echo Linux)"

    command -v docker &>/dev/null || die "Docker 未安装: curl -fsSL https://get.docker.com | sh"
    docker info &>/dev/null || die "Docker 未运行或当前用户无权限访问"
    log_info "Docker: $(docker --version)"

    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        die "需要 curl 或 wget"
    fi

    if ! command -v jq &>/dev/null && ! command -v python3 &>/dev/null; then
        die "需要 jq 或 python3 来操作 JSON"
    fi

    DOCKER_ROOT_DIR="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
    [[ -n "${DOCKER_ROOT_DIR}" ]] || DOCKER_ROOT_DIR="/var/lib/docker"
    log_info "Docker Root Dir: ${DOCKER_ROOT_DIR}"

    local cpu_cores mem_total_mb
    cpu_cores="$(nproc 2>/dev/null || echo 1)"
    mem_total_mb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 2097152) / 1024 ))

    CPU_LIMIT=$(( cpu_cores > 1 ? (cpu_cores - 1 > 4 ? 4 : cpu_cores - 1) : 1 ))
    local mem_limit_mb=$(( mem_total_mb - 1024 ))
    if (( mem_limit_mb > 8192 )); then
        mem_limit_mb=8192
    fi
    if (( mem_limit_mb < 1024 )); then
        mem_limit_mb=1024
    fi
    MEM_LIMIT="${mem_limit_mb}m"

    log_info "规格: ${cpu_cores}核/${mem_total_mb}MB → 容器限制: ${CPU_LIMIT}核/${MEM_LIMIT}"
    if (( mem_total_mb < 2048 )); then
        log_warn "内存 < 2GB，Hermes 可能不稳定"
    fi

    check_openclaw_compatibility
    check_disk_space
    init_cache_dir
}

# ─── 阶段 2：镜像拉取 ────────────────────────────────────────────────────────
phase2_pull_image() {
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
}

# ─── 阶段 3：配置收集（自动从 OpenClaw 读取） ────────────────────────────────
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

    choose_value "${CLI_API_PROVIDER}" "${HERMES_API_PROVIDER:-}" "${OC_PROVIDER:-}" "ark" API_PROVIDER provider_source
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

    if [[ "${provider_source}" == "cli" || "${api_key_source}" == "cli" || "${model_source}" == "cli" || "${base_url_source}" == "cli" ]]; then
        log_info "检测到 CLI 参数覆盖，将优先使用用户显式指定的连接信息"
    fi
}

# ─── 阶段 4：插件安装 ────────────────────────────────────────────────────────
phase4_install_plugin() {
    log_step "安装插件"

    local plugin_path=""
    collect_plugin_dir_candidates
    local plugin_dir="${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}"

    if [[ -n "${TOS_PLUGIN_URL}" ]]; then
        local plugin_tar="${CACHE_DIR}/hermes-plugin.tar.gz"

        log_info "下载插件: ${TOS_PLUGIN_URL}"
        download_file "${TOS_PLUGIN_URL}" "${plugin_tar}"
        plugin_path="${plugin_tar}"
    elif [[ -d "${plugin_dir}" ]]; then
        log_info "未提供插件下载地址，复用本地插件目录: ${plugin_dir}"
        plugin_path="${plugin_dir}"
    else
        local candidate_dir=""
        for candidate_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
            if [[ -d "${candidate_dir}" ]]; then
                log_info "未提供插件下载地址，复用本地插件目录: ${candidate_dir}"
                plugin_path="${candidate_dir}"
                break
            fi
        done
        [[ -n "${plugin_path}" ]] || die "TOS_PLUGIN_URL 未设置且本地不存在插件目录，无法继续"
    fi

    if [[ -f "${plugin_path}" ]]; then
        remove_installed_plugin_directories
    fi

    local install_args=("${plugin_path}")
    local current_oc_version
    current_oc_version="$(openclaw --version 2>&1 | tr -d '\r')"
    local current_oc_num threshold_num
    current_oc_num="$(version_to_number "${current_oc_version}" 2>/dev/null)" || current_oc_num=0
    threshold_num="$(version_to_number "2026.3.28")" || threshold_num=99999999
    if (( current_oc_num > threshold_num )); then
        install_args+=("--dangerously-force-unsafe-install")
    fi

    log_info "执行 openclaw plugins install ${install_args[*]}"
    openclaw plugins install "${install_args[@]}"
    log_info "插件安装完成"

    log_info "写入插件配置: ${OPENCLAW_CONFIG}"
    if command -v jq &>/dev/null; then
        local tmp
        tmp="$(mktemp)"
        register_temp "${tmp}"
        jq --arg cn "${CONTAINER_NAME}" --arg dm "${DEFAULT_MODEL_VAL}" \
           --arg pk "${PLUGIN_CONFIG_KEY}" \
           --arg legacy_pk "hermes" \
           '.plugins.entries[$pk].config = {
               "hermesContainerName": $cn,
               "defaultModel": $dm,
               "autoStrategy": true,
               "enableLayeredProtocol": false,
               "timeout": 600
           }
           | del(.plugins.entries[$legacy_pk])
           | .plugins.allow = (((.plugins.allow // []) | map(select(. != $legacy_pk))) + [$pk] | unique)
           | .plugins.entries[$pk].enabled = true
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
             }' "${OPENCLAW_CONFIG}" > "${tmp}" \
           && mv "${tmp}" "${OPENCLAW_CONFIG}"
    else
        python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" "${CONTAINER_NAME}" "${DEFAULT_MODEL_VAL}" <<'PYEOF'
import json, sys
cf, pk, cn, dm = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(cf) as f:
    d = json.load(f)
hermes = d.setdefault('plugins', {}).setdefault('entries', {}).setdefault(pk, {})
d['plugins']['entries'].pop('hermes', None)
hermes['enabled'] = True
hermes['config'] = {
    'hermesContainerName': cn,
    'defaultModel': dm,
    'autoStrategy': True,
    'enableLayeredProtocol': False,
    'timeout': 600
}
d.setdefault('agents', {}).setdefault('defaults', {}).setdefault('models', {}).update({
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
}
allow = d.setdefault('plugins', {}).setdefault('allow', [])
allow = [item for item in allow if item != 'hermes']
if pk not in allow:
    allow.append(pk)
d['plugins']['allow'] = allow
with open(cf, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
PYEOF
    fi
    log_info "插件配置已写入"

    update_config_yaml || log_info "config.yaml 尚未生成，将在容器首次启动后由 entrypoint 创建"
}

# ─── 阶段 5：启动容器 ────────────────────────────────────────────────────────
phase5_start_container() {
    log_step "启动容器"

    if ! start_container_from_image "${HERMES_IMAGE_NAME}:latest" true false; then
        die "新版本容器启动失败或健康检查未通过"
    fi

    restart_openclaw_gateway
}

# ─── 阶段 6：部署摘要 ────────────────────────────────────────────────────────
phase6_summary() {
    echo ""
    echo -e "${GREEN}  Hermes Agent 部署/升级完成${NC}"
    echo ""
    local status
    status="$(docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Status}}' 2>/dev/null || echo "未知")"
    echo -e "  容器: ${CYAN}${CONTAINER_NAME} (${status})${NC}"
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

    remove_installed_plugin_directories

    if [[ -f "${OPENCLAW_CONFIG}" ]]; then
        if command -v jq &>/dev/null; then
            local tmp
            tmp="$(mktemp)"
            jq --arg pk "${PLUGIN_CONFIG_KEY}" 'del(.plugins.entries[$pk])' "${OPENCLAW_CONFIG}" > "${tmp}" && mv "${tmp}" "${OPENCLAW_CONFIG}"
        else
            python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" <<'PYEOF'
import json, sys
cf, pk = sys.argv[1], sys.argv[2]
with open(cf) as f:
    d = json.load(f)
d.get('plugins', {}).get('entries', {}).pop(pk, None)
with open(cf, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
PYEOF
        fi
        log_info "配置已清理"
    fi

    if image_exists "${HERMES_IMAGE_NAME}:latest"; then
        docker rmi "${HERMES_IMAGE_NAME}:latest" 2>/dev/null || true
        log_info "镜像已删除"
    fi

    log_info "清理完成"
}

# ─── 入口 ────────────────────────────────────────────────────────────────────
main() {
    init_logging
    trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR
    parse_args "$@"

    if [[ "${CLEANUP_REQUESTED}" == true ]]; then
        do_cleanup
        exit 0
    fi

    echo -e "${CYAN}  Hermes Agent 一键部署 / 安全升级${NC}"
    echo ""

    phase1_check_env
    prepare_restore_point
    phase2_pull_image
    phase3_collect_config
    phase4_install_plugin
    phase5_start_container

    ROLLBACK_ARMED=false
    cleanup_rollback_artifacts
    phase6_summary
}

main "$@"

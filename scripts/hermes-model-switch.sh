#!/usr/bin/env bash
# 该脚本用于切换 Hermes-agent 使用的模型
# 用法：./hermes-model-switch.sh --api-key xxx --provider ark --model doubao-seed-code --base-url https://...


set -Eeuo pipefail

# ─── 配置 ────────────────────────────────────────────────────────────────────
CONTAINER_NAME="hermes-agent"
DATA_DIR="/opt/hermes-data"
ACP_PORT=3100
HEALTH_CHECK_TIMEOUT=180
HEALTH_CHECK_POST_START_GRACE=20

# ─── 运行时变量 ──────────────────────────────────────────────────────────────
API_KEY=""
API_PROVIDER=""
DEFAULT_MODEL_VAL=""
API_BASE_URL=""

CPU_LIMIT=""
MEM_LIMIT=""

LOG_DIR="/opt/log/hermes-agent"
LOG_FILE=""

# ─── 颜色（自动检测 TTY，管道模式下禁用颜色） ────────────────────────────────
if [[ -t 1 ]]; then
    RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' NC=''
fi

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

init_logging() {
    local run_ts
    run_ts="$(date '+%Y%m%d-%H%M%S')"

    if ! mkdir -p "${LOG_DIR}" 2>/dev/null; then
        LOG_DIR="${TMPDIR:-/tmp}/hermes-agent"
        mkdir -p "${LOG_DIR}" || die "无法创建日志目录: ${LOG_DIR}"
    fi

    LOG_FILE="${LOG_DIR}/model-switch-${run_ts}.log"
    touch "${LOG_FILE}" || die "无法创建日志文件: ${LOG_FILE}"

    exec > >(tee -a "${LOG_FILE}") 2>&1
    log_info "日志文件: ${LOG_FILE}"
}

log_line() {
    local level="$1" color="$2"
    shift 2
    printf '%b%s [%s]%b %s\n' "${color}" "$(timestamp)" "${level}" "${NC}" "$*"
}

log_info()  { log_line "INFO" "${GREEN}" "$*"; }
log_warn()  { log_line "WARN" "${YELLOW}" "$*"; }
log_error() { log_line "ERROR" "${RED}" "$*"; }
log_step()  { printf '\n%b%s [STEP]%b %s\n' "${CYAN}" "$(timestamp)" "${NC}" "$1"; }
die()       { log_error "$@"; exit 1; }

usage() {
    cat <<'EOF'
Hermes Agent 模型切换脚本

选项:
  --api-key <value>    指定新的 API Key
  --provider <value>   指定新的 Provider (如 ark, openai 等)
  --model <value>      指定新的默认模型
  --base-url <value>   指定新的 API Base URL
  --help, -h           显示帮助

注意:
  传入 --api-key 或 --base-url 时，必须同时传入 --provider
  仅切换模型时，只需传入 --model

示例:
  # 仅切换模型
  ./hermes-model-switch.sh --model doubao-seed-code

  # 切换 provider 和 key
  ./hermes-model-switch.sh --api-key xxx --provider ark --model doubao-seed-code --base-url https://...
EOF
}

require_arg_value() {
    local option_name="$1" option_value="${2:-}"
    [[ -n "${option_value}" ]] || die "参数 ${option_name} 缺少值"
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --api-key)
                shift
                require_arg_value "--api-key" "${1:-}"
                API_KEY="$1"
                ;;
            --provider)
                shift
                require_arg_value "--provider" "${1:-}"
                API_PROVIDER="$1"
                ;;
            --model)
                shift
                require_arg_value "--model" "${1:-}"
                DEFAULT_MODEL_VAL="$1"
                ;;
            --base-url)
                shift
                require_arg_value "--base-url" "${1:-}"
                API_BASE_URL="$1"
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

mask_secret() {
    local value="$1"
    local len="${#value}"
    if (( len <= 8 )); then
        printf '****'
    else
        printf '%s...%s' "${value:0:4}" "${value: -4}"
    fi
}

container_exists() {
    docker ps -a --format '{{.Names}}' | grep -qx "$1"
}

container_running() {
    docker ps --format '{{.Names}}' | grep -qx "$1"
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

# 更新 .env 文件，保留现有变量，仅覆盖/新增模型相关变量
update_env_file() {
    local env_file="${DATA_DIR}/.env"

    if [[ ! -f "${env_file}" ]]; then
        die "容器环境文件不存在: ${env_file}，请先执行部署脚本"
    fi

    log_info "更新容器环境文件: ${env_file}"

    declare -A env_map
    while IFS= read -r line || [[ -n "${line}" ]]; do
        [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
        if [[ "${line}" == *"="* ]]; then
            local key="${line%%=*}"
            local value="${line#*=}"
            key="$(echo "${key}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
            env_map["${key}"]="${value}"
        fi
    done < "${env_file}"

    if [[ -n "${API_KEY}" ]]; then
        local api_env_key
        api_env_key="$(provider_to_env_key "${API_PROVIDER}")"
        env_map["${api_env_key}"]="${API_KEY}"
        if [[ "${api_env_key}" != "OPENAI_API_KEY" ]]; then
            env_map["OPENAI_API_KEY"]="${API_KEY}"
        fi
        log_info "更新环境变量: ${api_env_key}=$(mask_secret "${API_KEY}")"
    fi

    if [[ -n "${API_BASE_URL}" ]]; then
        local base_env
        base_env="$(provider_to_base_url_env "${API_PROVIDER}")"
        if [[ -n "${base_env}" ]]; then
            env_map["${base_env}"]="${API_BASE_URL}"
            if [[ "${base_env}" != "OPENAI_BASE_URL" ]]; then
                env_map["OPENAI_BASE_URL"]="${API_BASE_URL}"
            fi
            log_info "更新环境变量: ${base_env}=${API_BASE_URL}"
        fi
    fi

    {
        for key in "${!env_map[@]}"; do
            echo "${key}=${env_map[${key}]}"
        done
    } > "${env_file}"

    chmod 600 "${env_file}"
    log_info "环境文件已更新"
}

# 更新 config.yaml 中的 default、provider 和 base_url
# YAML 格式示例:
#   default: "model-name"
#   provider: "provider"
#   base_url: "https://..."
update_config_yaml() {
    local config_yaml="${DATA_DIR}/config.yaml"
    if [[ ! -f "${config_yaml}" ]]; then
        log_warn "config.yaml 尚未生成，跳过更新（容器启动后将由 entrypoint 创建）"
        return 0
    fi

    log_info "更新 Hermes config.yaml"

    if [[ -n "${DEFAULT_MODEL_VAL}" ]]; then
        local before after
        before="$(grep -E '^\s*default:' "${config_yaml}" 2>/dev/null || true)"
        sed -i "s|^\(\s*default:\s*\).*|\1\"${DEFAULT_MODEL_VAL}\"|" "${config_yaml}"
        after="$(grep -E '^\s*default:' "${config_yaml}" 2>/dev/null || true)"
        if [[ "${before}" != "${after}" ]]; then
            log_info "default 已更新: ${before} -> ${after}"
        else
            log_warn "default 行未匹配或未变更，当前值: ${before:-未找到}"
        fi
    fi

    if [[ -n "${API_PROVIDER}" ]]; then
        local before after
        before="$(grep -E '^\s*provider:' "${config_yaml}" 2>/dev/null || true)"
        sed -i "s|^\(\s*provider:\s*\).*|\1\"${API_PROVIDER}\"|" "${config_yaml}"
        after="$(grep -E '^\s*provider:' "${config_yaml}" 2>/dev/null || true)"
        if [[ "${before}" != "${after}" ]]; then
            log_info "provider 已更新: ${before} -> ${after}"
        else
            log_warn "provider 行未匹配或未变更，当前值: ${before:-未找到}"
        fi
    fi

    if [[ -n "${API_BASE_URL}" ]]; then
        local before after
        before="$(grep -E '^\s*base_url:' "${config_yaml}" 2>/dev/null || true)"
        sed -i "s|^\(\s*base_url:\s*\).*|\1\"${API_BASE_URL}\"|" "${config_yaml}"
        after="$(grep -E '^\s*base_url:' "${config_yaml}" 2>/dev/null || true)"
        if [[ "${before}" != "${after}" ]]; then
            log_info "base_url 已更新: ${before} -> ${after}"
        else
            log_warn "base_url 行未匹配或未变更，当前值: ${before:-未找到}"
        fi
    fi

    log_info "config.yaml 更新完成 (model=${DEFAULT_MODEL_VAL:-未变更}, provider=${API_PROVIDER:-未变更}, base_url=${API_BASE_URL:-未变更})"
}

# 从现有容器获取镜像名
get_container_image() {
    docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}" 2>/dev/null
}

# 自动检测 CPU 和内存限制
detect_resource_limits() {
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
    log_info "资源限制: CPU=${CPU_LIMIT}核, 内存=${MEM_LIMIT}"
}

# 重建容器以加载新的环境变量
# docker restart 不会重新读取 --env-file，必须删除并重建容器
recreate_container() {
    log_step "重建容器以加载新配置"

    local image_ref
    image_ref="$(get_container_image)"
    if [[ -z "${image_ref}" ]]; then
        die "无法获取容器 ${CONTAINER_NAME} 的镜像名"
    fi
    log_info "当前容器镜像: ${image_ref}"

    detect_resource_limits

    log_info "停止并删除旧容器 ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}" >/dev/null

    log_info "使用更新后的配置重建容器"
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

    log_info "容器已重建"
}

check_prerequisites() {
    log_step "检查前置条件"

    command -v docker &>/dev/null || die "Docker 未安装"
    docker info &>/dev/null || die "Docker 未运行或当前用户无权限访问"
    log_info "Docker 检查通过"

    if ! container_exists "${CONTAINER_NAME}"; then
        die "容器 ${CONTAINER_NAME} 不存在，请先执行部署脚本"
    fi
    log_info "容器 ${CONTAINER_NAME} 存在"

    if ! container_running "${CONTAINER_NAME}"; then
        die "容器 ${CONTAINER_NAME} 未运行"
    fi
    log_info "容器 ${CONTAINER_NAME} 运行中"

    if [[ ! -d "${DATA_DIR}" ]]; then
        die "数据目录 ${DATA_DIR} 不存在"
    fi
    log_info "数据目录检查通过: ${DATA_DIR}"

    if [[ ! -f "${DATA_DIR}/.env" ]]; then
        die "容器环境文件 ${DATA_DIR}/.env 不存在，请先执行部署脚本"
    fi
}

print_summary() {
    echo ""
    echo -e "${GREEN}  Hermes Agent 模型切换完成${NC}"
    echo ""
    local status
    status="$(docker ps --filter "name=^/${CONTAINER_NAME}$" --format '{{.Status}}' 2>/dev/null || echo "未知")"
    echo -e "  容器: ${CYAN}${CONTAINER_NAME} (${status})${NC}"
    echo -e "  端口: ${CYAN}${ACP_PORT}${NC}"
    if [[ -n "${API_PROVIDER}" ]]; then
        echo -e "  Provider: ${CYAN}${API_PROVIDER}${NC}"
    fi
    if [[ -n "${DEFAULT_MODEL_VAL}" ]]; then
        echo -e "  模型: ${CYAN}${DEFAULT_MODEL_VAL}${NC}"
    fi
    if [[ -n "${API_KEY}" ]]; then
        echo -e "  API Key: ${CYAN}$(mask_secret "${API_KEY}")${NC}"
    fi
    if [[ -n "${API_BASE_URL}" ]]; then
        echo -e "  Base URL: ${CYAN}${API_BASE_URL}${NC}"
    fi
    echo ""
}

main() {
    parse_args "$@"
    init_logging

    if [[ -z "${API_KEY}" && -z "${API_PROVIDER}" && -z "${DEFAULT_MODEL_VAL}" && -z "${API_BASE_URL}" ]]; then
        die "至少需要指定一个参数 (--api-key, --provider, --model, --base-url)"
    fi

    check_prerequisites

    # 判断是否需要重建容器
    # .env 中的环境变量在 docker run 时注入，docker restart 不会重新读取
    # config.yaml 通过 volume 挂载，重启后容器可直接读取更新
    local need_recreate=false
    if [[ -n "${API_KEY}" || -n "${API_BASE_URL}" ]]; then
        need_recreate=true
    fi

    if [[ "${need_recreate}" == true ]]; then
        update_env_file
        update_config_yaml
        recreate_container
        wait_for_container_ready || die "容器重建后健康检查未通过"
    else
        update_config_yaml
        log_step "重启容器以加载更新后的 config.yaml"
        docker restart "${CONTAINER_NAME}" >/dev/null
        wait_for_container_ready || die "容器重启后健康检查未通过"
    fi

    print_summary
}

main "$@"

#!/usr/bin/env bash
# Hermes Agent 模型切换脚本
# 用法：./hermes-model-switch.sh --api-key xxx --model doubao-seed-code --base-url https://...
#
# 注意：
#   - provider 已固定为 "custom"，不再支持通过 --provider 传入
#   - 与 hermes-install-v2.sh 保持一致：host 网络、固定资源限制、容器重建前自动备份

set -Eeuo pipefail

# ─── 配置 ────────────────────────────────────────────────────────────────────
CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
ACP_PORT="${ACP_PORT:-3100}"
ACP_TCP_HOST="${ACP_TCP_HOST:-127.0.0.1}"
ACP_TCP_PORT="${ACP_TCP_PORT:-3100}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-180}"
HEALTH_CHECK_POST_START_GRACE="${HEALTH_CHECK_POST_START_GRACE:-20}"

# Provider 固定为 custom，不允许通过命令行覆盖
API_PROVIDER="custom"

# ─── 运行时变量 ──────────────────────────────────────────────────────────────
API_KEY=""
DEFAULT_MODEL_VAL=""
API_BASE_URL=""

# 与 hermes-install-v2.sh 保持一致：固定 CPU/MEM 限制
CPU_LIMIT="2"
MEM_LIMIT="4g"

LOG_DIR="/var/log/hermes-agent"
LOG_FILE=""

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
die()       { log_error "$@"; exit 1; }

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

usage() {
    cat <<'EOF'
Hermes Agent 模型切换脚本

选项:
  --api-key <value>    指定新的 API Key（与 --base-url 同时使用以切换上游服务）
  --model <value>      指定新的默认模型
  --base-url <value>   指定新的 API Base URL
  --help, -h           显示帮助

说明:
  - provider 已固定为 "custom"，不再接受 --provider 参数
  - 仅切换模型时，只需传入 --model（仅更新 config.yaml 后重启容器）
  - 传入 --api-key 或 --base-url 时，会重写 .env 并重建容器以加载新环境变量
  - 容器重建前会自动备份容器内 /root 目录到 ${DATA_DIR}/bak

示例:
  # 仅切换模型
  ./hermes-model-switch.sh --model doubao-seed-code

  # 切换 key + base url + 模型（需要重建容器）
  ./hermes-model-switch.sh --api-key xxx --model doubao-seed-code --base-url https://...
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
                # 显式拒绝传入 provider，避免与固定值 custom 冲突
                shift || true
                die "--provider 已不再支持，provider 已固定为 \"custom\""
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

# 与 hermes-install-v2.sh 中 wait_for_container_ready 行为对齐：
# 健康检查超时但容器仍在运行时，按容忍策略判定为成功，仅给出 WARN 提示
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

    # 与 install-v2 一致的容忍策略：超时但容器仍在运行 → 视为成功
    log_warn "健康检查超时，但容器仍在运行；按容忍策略判定为成功，请稍后通过 'docker logs -f ${CONTAINER_NAME}' 自行确认"
    docker logs --tail 120 "${CONTAINER_NAME}" 2>/dev/null || true
    if container_running "${CONTAINER_NAME}"; then
        return 0
    fi
    log_warn "容器在健康检查结束时已退出"
    return 1
}

# Provider → API Key 环境变量名（与 install-v2 保持一致）
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

# Provider → Base URL 环境变量名（与 install-v2 保持一致）
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

# 更新 .env 文件，保留现有变量，仅覆盖/新增模型相关变量
# 同时对齐 install-v2 的 write_env_file：
#   - HERMES_UID/HERMES_GID/HERMES_HOME
#   - ACP_TCP_HOST/ACP_TCP_PORT
#   - GATEWAY_ALLOW_ALL_USERS
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

    # 补齐与 install-v2 一致的固定项（缺失则补，存在则保留用户原值）
    : "${env_map[HERMES_UID]:=0}"
    : "${env_map[HERMES_GID]:=0}"
    : "${env_map[HERMES_HOME]:=/opt/data}"
    : "${env_map[ACP_TCP_HOST]:=${ACP_TCP_HOST}}"
    : "${env_map[ACP_TCP_PORT]:=${ACP_TCP_PORT}}"
    : "${env_map[GATEWAY_ALLOW_ALL_USERS]:=true}"

    if [[ -n "${API_KEY}" ]]; then
        local api_env_key
        api_env_key="$(provider_to_env_key "${API_PROVIDER}")"
        env_map["${api_env_key}"]="${API_KEY}"
        # custom provider 同时回写 OPENAI_API_KEY 兜底（与 install-v2 一致）
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
        local key
        for key in "${!env_map[@]}"; do
            echo "${key}=${env_map[${key}]}"
        done
    } > "${env_file}"

    chmod 600 "${env_file}"
    log_info "环境文件已更新"
}

# 更新 config.yaml 中的 default、provider 和 base_url
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

    # provider 始终强制为 custom，确保配置与脚本固定值一致
    local before after
    before="$(grep -E '^\s*provider:' "${config_yaml}" 2>/dev/null || true)"
    sed -i "s|^\(\s*provider:\s*\).*|\1\"${API_PROVIDER}\"|" "${config_yaml}"
    after="$(grep -E '^\s*provider:' "${config_yaml}" 2>/dev/null || true)"
    if [[ "${before}" != "${after}" ]]; then
        log_info "provider 已更新: ${before} -> ${after}"
    fi

    if [[ -n "${API_BASE_URL}" ]]; then
        local before2 after2
        before2="$(grep -E '^\s*base_url:' "${config_yaml}" 2>/dev/null || true)"
        sed -i "s|^\(\s*base_url:\s*\).*|\1\"${API_BASE_URL}\"|" "${config_yaml}"
        after2="$(grep -E '^\s*base_url:' "${config_yaml}" 2>/dev/null || true)"
        if [[ "${before2}" != "${after2}" ]]; then
            log_info "base_url 已更新: ${before2} -> ${after2}"
        else
            log_warn "base_url 行未匹配或未变更，当前值: ${before2:-未找到}"
        fi
    fi

    log_info "config.yaml 更新完成 (provider=${API_PROVIDER}, model=${DEFAULT_MODEL_VAL:-未变更}, base_url=${API_BASE_URL:-未变更})"
}

# 从现有容器获取镜像名（用于重建时复用同一镜像版本）
get_container_image() {
    docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}" 2>/dev/null
}

# 重建容器前先备份容器内 /root 到宿主机数据目录
# 参考 hermes-install-v2.sh#L1943-L1951 的备份逻辑
backup_container_root() {
    if ! container_running "${CONTAINER_NAME}"; then
        log_warn "容器 ${CONTAINER_NAME} 未运行，跳过 /root 备份"
        return 0
    fi

    local backup_dir="${DATA_DIR}/bak"
    mkdir -p "${backup_dir}"
    log_info "备份容器 ${CONTAINER_NAME} 内 /root 目录到 ${backup_dir}"
    docker exec "${CONTAINER_NAME}" bash -c \
        'tar cf - -C /root . 2>/dev/null' | tar xf - -C "${backup_dir}" 2>/dev/null || \
        log_warn "容器内文件备份失败（非致命），继续切换流程"
}

# 重建容器以加载新的环境变量
# docker restart 不会重新读取 --env-file，必须删除并重建容器
# 与 hermes-install-v2.sh start_container_from_image 的 docker run 参数保持一致
recreate_container() {
    log_step "重建容器以加载新配置"

    local image_ref
    image_ref="$(get_container_image)"
    if [[ -z "${image_ref}" ]]; then
        die "无法获取容器 ${CONTAINER_NAME} 的镜像名"
    fi
    log_info "当前容器镜像: ${image_ref}"
    log_info "资源限制: CPU=${CPU_LIMIT}核, 内存=${MEM_LIMIT}"

    # 重建前备份容器内 /root，避免历史数据丢失
    backup_container_root

    log_info "停止并删除旧容器 ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}" >/dev/null

    log_info "使用更新后的配置重建容器"
    docker run -d \
        --name "${CONTAINER_NAME}" \
        --init \
        --restart unless-stopped \
        --user root \
        --network host \
        -e ACP_TCP_HOST="${ACP_TCP_HOST}" \
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
    echo -e "  Provider: ${CYAN}${API_PROVIDER} (固定)${NC}"
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

    if [[ -z "${API_KEY}" && -z "${DEFAULT_MODEL_VAL}" && -z "${API_BASE_URL}" ]]; then
        die "至少需要指定一个参数 (--api-key, --model, --base-url)"
    fi

    log_info "Provider 固定为: ${API_PROVIDER}"

    check_prerequisites

    # 判断是否需要重建容器：
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
        # 仅切换模型时不需要备份（无数据丢失风险，仅 restart 不重建）
        docker restart "${CONTAINER_NAME}" >/dev/null
        wait_for_container_ready || die "容器重启后健康检查未通过"
    fi

    print_summary
}

main "$@"

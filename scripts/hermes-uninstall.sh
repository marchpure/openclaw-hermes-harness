#!/usr/bin/env bash
# Hermes Agent 卸载脚本
# 用法:
#   sudo bash hermes-uninstall.sh
#   sudo bash hermes-uninstall.sh --yes
#
# 与 hermes-install-v2.sh 保持一致，覆盖以下残留：
#   - 容器 / 镜像（含 hermes-agent:rollback-* 标签）
#   - 数据目录、缓存目录、日志目录
#   - 后台安装的 tmux 会话与 .install-* 状态文件
#   - OpenClaw 插件目录与 openclaw.json 中的所有 Hermes 相关条目
#     （plugins / models.providers.hermes / agents.defaults.models / agentRuntime / model）

set -Eeuo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-hermes-agent}"
DATA_DIR="${DATA_DIR:-/opt/hermes-data}"
CACHE_DIR="${CACHE_DIR:-/var/cache/hermes-agent}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-/root/.openclaw/openclaw.json}"
OPENCLAW_EXTENSIONS_DIR="${OPENCLAW_EXTENSIONS_DIR:-/root/.openclaw/extensions}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-openclaw-plugin-hermes}"
PLUGIN_DIR_NAME="${PLUGIN_DIR_NAME:-openclaw-plugin-hermes}"
PLUGIN_LEGACY_DIR_NAME="${PLUGIN_LEGACY_DIR_NAME:-hermes}"
HERMES_IMAGE_NAME="${HERMES_IMAGE_NAME:-hermes-agent}"
LOG_DIR_PRIMARY="${LOG_DIR_PRIMARY:-/var/log/hermes-agent}"
LOG_DIR_FALLBACK="${LOG_DIR_FALLBACK:-/tmp/hermes-agent}"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-hermes-install}"
OPENCLAW_GATEWAY_READY_TIMEOUT="${OPENCLAW_GATEWAY_READY_TIMEOUT:-30}"
OPENCLAW_GATEWAY_FALLBACK_SLEEP="${OPENCLAW_GATEWAY_FALLBACK_SLEEP:-5}"

ASSUME_YES=false
KEEP_DATA=false
CONFIG_CHANGED=false

declare -a PLUGIN_DIR_CANDIDATES=()

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

usage() {
    cat <<'EOF'
Hermes Agent 卸载脚本

选项:
  --yes, -y       不再询问确认，直接执行彻底清理
  --keep-data     保留 /opt/hermes-data 数据目录（仅清理容器/镜像/插件/配置/缓存/日志）
  --help, -h      显示帮助

清理范围:
  - 删除 Docker 容器 hermes-agent
  - 删除 Docker 镜像 hermes-agent:*（包括 rollback 标签）
  - 删除 /opt/hermes-data 整个数据目录（除非 --keep-data）
  - 删除安装缓存目录 /var/cache/hermes-agent（含 .install-* 状态文件）
  - 关闭后台安装 tmux 会话 hermes-install（如有）
  - 删除 OpenClaw 插件目录 /root/.openclaw/extensions/openclaw-plugin-hermes
  - 兼容清理旧目录 /root/.openclaw/extensions/hermes
  - 从 /root/.openclaw/openclaw.json 中移除所有 Hermes 相关条目
    （plugins / models.providers.hermes / agents.defaults.models["hermes/default"|"hermes"]
     / agents.defaults.agentRuntime / agents.defaults.model）
  - 删除升级日志目录 /var/log/hermes-agent 和 /tmp/hermes-agent
EOF
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

require_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        die "请使用 root 或 sudo 运行该卸载脚本"
    fi
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --yes|-y)
                ASSUME_YES=true
                ;;
            --keep-data)
                KEEP_DATA=true
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

confirm_destructive_action() {
    if [[ "${ASSUME_YES}" == true ]]; then
        return 0
    fi

    local data_line="数据目录: ${DATA_DIR}"
    if [[ "${KEEP_DATA}" == true ]]; then
        data_line="数据目录: ${DATA_DIR} (将保留)"
    fi

    cat <<EOF
将要彻底删除 Hermes 安装与升级残留：
  - Docker 容器: ${CONTAINER_NAME}
  - Docker 镜像: ${HERMES_IMAGE_NAME}:*（含 rollback 标签）
  - ${data_line}
  - 缓存目录: ${CACHE_DIR}
  - 后台安装 tmux 会话: ${TMUX_SESSION_NAME}
  - 插件目录: ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}
  - 兼容旧目录: ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}
  - OpenClaw 配置中的 Hermes 插件 / Provider / Agents Runtime 条目
  - 日志目录: ${LOG_DIR_PRIMARY}, ${LOG_DIR_FALLBACK}

EOF
    read -r -p "确认继续吗？输入 yes 继续: " answer
    if [[ "${answer}" != "yes" ]]; then
        die "用户取消执行"
    fi
}

safe_remove_path() {
    local target="$1" label="$2"

    if [[ -e "${target}" ]]; then
        rm -rf -- "${target}"
        log_info "已删除 ${label}: ${target}"
    else
        log_info "${label} 不存在，跳过: ${target}"
    fi
}

# 关闭可能仍在运行的后台安装 tmux 会话，避免与卸载操作冲突
cleanup_background_session() {
    log_step "清理后台安装会话"

    if ! command -v tmux &>/dev/null; then
        log_info "未安装 tmux，跳过"
        return 0
    fi

    if tmux has-session -t "${TMUX_SESSION_NAME}" 2>/dev/null; then
        tmux kill-session -t "${TMUX_SESSION_NAME}" 2>/dev/null || true
        log_info "已关闭 tmux 会话: ${TMUX_SESSION_NAME}"
    else
        log_info "未发现 tmux 会话，跳过: ${TMUX_SESSION_NAME}"
    fi
}

cleanup_container() {
    log_step "清理 Docker 容器"

    if ! command -v docker &>/dev/null; then
        log_warn "未找到 docker 命令，跳过容器删除"
        return 0
    fi

    if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
        docker rm -f "${CONTAINER_NAME}" >/dev/null
        log_info "已删除容器: ${CONTAINER_NAME}"
    else
        log_info "容器不存在，跳过: ${CONTAINER_NAME}"
    fi
}

cleanup_images() {
    log_step "清理 Docker 镜像"

    if ! command -v docker &>/dev/null; then
        log_warn "未找到 docker 命令，跳过镜像删除"
        return 0
    fi

    # 同时匹配 hermes-agent:latest / hermes-agent:rollback-* 等所有 tag
    local -a images=()
    mapfile -t images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E "^${HERMES_IMAGE_NAME}:" || true)

    if (( ${#images[@]} == 0 )); then
        log_info "未发现 ${HERMES_IMAGE_NAME}:* 镜像，跳过"
        return 0
    fi

    local image_ref=""
    for image_ref in "${images[@]}"; do
        if docker rmi -f "${image_ref}" >/dev/null; then
            log_info "已删除镜像: ${image_ref}"
        else
            log_warn "删除镜像失败，可能仍被占用: ${image_ref}"
        fi
    done
}

# 通过 openclaw CLI 卸载插件（best-effort），无论成功与否后续都会兜底清理目录与配置
try_openclaw_uninstall() {
    if ! command -v openclaw &>/dev/null; then
        log_warn "未找到 openclaw 命令，跳过 CLI 卸载，回退到手动清理"
        return 1
    fi

    log_info "调用 openclaw plugins uninstall openclaw-plugin-hermes"
    if echo "y" | openclaw plugins uninstall openclaw-plugin-hermes 2>/dev/null; then
        log_info "openclaw plugins uninstall 执行成功"
        CONFIG_CHANGED=true
        return 0
    fi

    log_warn "openclaw plugins uninstall 执行失败，将通过手动方式清理"
    return 1
}

# 兜底删除残留的插件目录
cleanup_plugin_dirs() {
    collect_plugin_dir_candidates
    local plugin_dir=""
    for plugin_dir in "${PLUGIN_DIR_CANDIDATES[@]}"; do
        safe_remove_path "${plugin_dir}" "插件目录"
    done
}

# 与 hermes-install-v2.sh 中 do_cleanup() 保持一致，
# 移除 openclaw.json 内所有 Hermes 残留：
#   - plugins.entries[hermes|openclaw-plugin-hermes]
#   - plugins.allow 中相应条目
#   - models.providers.hermes
#   - agents.defaults.models["hermes/default"|"hermes"]
#   - agents.defaults.agentRuntime / agents.defaults.model
cleanup_openclaw_config() {
    if [[ ! -f "${OPENCLAW_CONFIG}" ]]; then
        log_info "OpenClaw 配置文件不存在，跳过: ${OPENCLAW_CONFIG}"
        return 0
    fi

    if command -v jq &>/dev/null; then
        local tmp
        tmp="$(mktemp)"
        # 只在 .agents.defaults.model.primary 明确是 hermes 别名（hermes/xxx 或字面量 hermes）时
        # 才删除 .agents.defaults.model，避免误伤用户自定义的默认模型配置
        if jq --arg pk "${PLUGIN_CONFIG_KEY}" --arg legacy_pk "hermes" '
            del(.plugins.entries[$pk])
            | del(.plugins.entries[$legacy_pk])
            | .plugins.allow = ((.plugins.allow // []) | map(select(. != $pk and . != $legacy_pk)))
            | del(.models.providers.hermes)
            | del(.agents.defaults.models["hermes/default"])
            | del(.agents.defaults.models["hermes"])
            | del(.agents.defaults.agentRuntime)
            | (.agents.defaults.model.primary // null) as $primary
            | if ($primary | type) == "string"
                 and ($primary == "hermes" or ($primary | test("^hermes/")))
              then del(.agents.defaults.model)
              else .
              end
        ' "${OPENCLAW_CONFIG}" > "${tmp}"; then
            mv "${tmp}" "${OPENCLAW_CONFIG}"
            CONFIG_CHANGED=true
            log_info "已从 OpenClaw 配置移除全部 Hermes 相关条目 (jq)"
        else
            rm -f "${tmp}"
            log_warn "jq 处理 OpenClaw 配置失败，请手动检查: ${OPENCLAW_CONFIG}"
        fi
        return 0
    fi

    if command -v python3 &>/dev/null; then
        if python3 - "${OPENCLAW_CONFIG}" "${PLUGIN_CONFIG_KEY}" <<'PYEOF'
import json, sys
cfg, pk = sys.argv[1], sys.argv[2]
with open(cfg) as f:
    data = json.load(f)
# 移除插件条目
entries = data.get('plugins', {}).get('entries', {})
entries.pop(pk, None)
entries.pop('hermes', None)
allow = data.get('plugins', {}).get('allow', [])
data.setdefault('plugins', {})['allow'] = [item for item in allow if item not in (pk, 'hermes')]
# 移除 hermes provider
data.get('models', {}).get('providers', {}).pop('hermes', None)
# 移除 agents defaults 中的 hermes 别名与 runtime 配置
defaults = data.get('agents', {}).get('defaults', {})
aliases = defaults.get('models', {})
aliases.pop('hermes/default', None)
aliases.pop('hermes', None)
defaults.pop('agentRuntime', None)
# 仅当 defaults.model.primary 明确指向 hermes 别名时才删除 model 段，
# 避免误删用户自定义的默认模型设置
model_cfg = defaults.get('model')
if isinstance(model_cfg, dict):
    primary = model_cfg.get('primary', '')
    if isinstance(primary, str) and (primary == 'hermes' or primary.startswith('hermes/')):
        defaults.pop('model', None)
with open(cfg, 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
        then
            CONFIG_CHANGED=true
            log_info "已从 OpenClaw 配置移除全部 Hermes 相关条目 (python3)"
        else
            log_warn "python3 处理 OpenClaw 配置失败，请手动检查: ${OPENCLAW_CONFIG}"
        fi
        return 0
    fi

    log_warn "未找到 jq 或 python3，无法自动清理 ${OPENCLAW_CONFIG} 中的 Hermes 配置"
}

cleanup_openclaw_plugin() {
    log_step "清理 OpenClaw 插件与配置"

    # 1. 优先用 openclaw CLI 卸载插件（best-effort）
    try_openclaw_uninstall || true
    # 2. 无论 CLI 是否成功，都兜底清理插件目录残留
    cleanup_plugin_dirs
    # 3. 始终手动清理 openclaw.json 中所有 Hermes 条目
    #    （CLI 不会清理 provider / agents.defaults 等附加条目）
    cleanup_openclaw_config
}

cleanup_data_and_logs() {
    log_step "清理数据/缓存/日志目录"

    if [[ "${KEEP_DATA}" == true ]]; then
        log_info "按 --keep-data 保留数据目录: ${DATA_DIR}"
    else
        safe_remove_path "${DATA_DIR}" "Hermes 数据目录"
    fi

    safe_remove_path "${CACHE_DIR}" "Hermes 缓存目录 (含 .install-* 状态文件)"
    safe_remove_path "${LOG_DIR_PRIMARY}" "主日志目录"
    safe_remove_path "${LOG_DIR_FALLBACK}" "回退日志目录"
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

restart_openclaw_if_needed() {
    if [[ "${CONFIG_CHANGED}" != true ]]; then
        return 0
    fi

    log_step "重启 OpenClaw gateway"

    if ! command -v openclaw &>/dev/null; then
        log_warn "未找到 openclaw 命令，请手动重启 OpenClaw gateway"
        return 0
    fi

    if openclaw gateway restart >/dev/null 2>&1; then
        wait_for_openclaw_gateway
        log_info "OpenClaw gateway 重启完成"
    else
        log_warn "OpenClaw gateway 重启失败，请手动检查"
    fi
}

summary() {
    local data_status="已删除"
    [[ "${KEEP_DATA}" == true ]] && data_status="已保留"

    echo ""
    echo -e "${GREEN}  Hermes 清理完成${NC}"
    echo ""
    echo "  已清理的默认目标:"
    echo "    容器:     ${CONTAINER_NAME}"
    echo "    镜像:     ${HERMES_IMAGE_NAME}:* (含 rollback 标签)"
    echo "    数据:     ${DATA_DIR} (${data_status})"
    echo "    缓存:     ${CACHE_DIR}"
    echo "    tmux:     ${TMUX_SESSION_NAME}"
    echo "    插件:     ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_DIR_NAME}"
    echo "    旧插件:   ${OPENCLAW_EXTENSIONS_DIR}/${PLUGIN_LEGACY_DIR_NAME}"
    echo "    配置:     ${OPENCLAW_CONFIG} 中的 Hermes 全部条目"
    echo "    日志:     ${LOG_DIR_PRIMARY}, ${LOG_DIR_FALLBACK}"
    echo ""
}

main() {
    parse_args "$@"
    require_root

    log_info "准备在 Linux 环境中清理 Hermes 安装与升级残留"
    confirm_destructive_action

    cleanup_background_session
    cleanup_container
    cleanup_images
    cleanup_openclaw_plugin
    cleanup_data_and_logs
    restart_openclaw_if_needed
    summary
}

main "$@"

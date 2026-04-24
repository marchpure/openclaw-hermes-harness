#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_V2="${SCRIPT_DIR}/install-v2.sh"
UNINSTALL_V2="${SCRIPT_DIR}/uninstall-v2.sh"

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT

FAKE_BIN="${TEST_ROOT}/bin"
STATE_ROOT="${TEST_ROOT}/state"
mkdir -p "${FAKE_BIN}" "${STATE_ROOT}"

cat > "${FAKE_BIN}/openclaw" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR="${FAKE_OPENCLAW_STATE_DIR:?}"
CONFIG="${OPENCLAW_CONFIG:?}"
EXT_DIR="${OPENCLAW_EXTENSIONS_DIR:?}"
VERSION="${FAKE_OPENCLAW_VERSION:-OpenClaw 2026.4.15 (test)}"
mkdir -p "${STATE_DIR}" "${EXT_DIR}"

cmd="${1:-}"
shift || true

copy_plugin() {
    local src="$1"
    rm -rf "${EXT_DIR}/openclaw-plugin-hermes"
    mkdir -p "${EXT_DIR}"
    if [[ -d "${src}" ]]; then
        cp -a "${src}" "${EXT_DIR}/openclaw-plugin-hermes"
        return 0
    fi

    local tmp
    tmp="$(mktemp -d)"
    tar -C "${tmp}" -xzf "${src}"
    if [[ -d "${tmp}/openclaw-plugin-hermes" ]]; then
        cp -a "${tmp}/openclaw-plugin-hermes" "${EXT_DIR}/openclaw-plugin-hermes"
    else
        cp -a "${tmp}"/* "${EXT_DIR}/openclaw-plugin-hermes"
    fi
    rm -rf "${tmp}"
}

case "${cmd}" in
    --version)
        echo "${VERSION}"
        ;;
    plugins)
        sub="${1:-}"
        shift || true
        case "${sub}" in
            --help)
                cat <<'HELP'
Usage: openclaw plugins [options] [command]
Commands:
  install
  uninstall
HELP
                ;;
            install)
                plugin_path=""
                for arg in "$@"; do
                    if [[ "${arg}" == --* ]]; then
                        continue
                    fi
                    plugin_path="${arg}"
                    break
                done
                [[ -n "${plugin_path}" ]] || { echo "missing plugin path" >&2; exit 1; }
                copy_plugin "${plugin_path#file://}"
                echo installed > "${STATE_DIR}/plugin-installed"
                ;;
            uninstall)
                rm -rf "${EXT_DIR}/openclaw-plugin-hermes" "${EXT_DIR}/hermes"
                rm -f "${STATE_DIR}/plugin-installed"
                ;;
            *)
                echo "unsupported plugins subcommand" >&2
                exit 1
                ;;
        esac
        ;;
    gateway)
        sub="${1:-}"
        shift || true
        case "${sub}" in
            --help)
                cat <<'HELP'
Usage: openclaw gateway [options] [command]
Commands:
  restart
  status
HELP
                ;;
            restart)
                echo ready > "${STATE_DIR}/gateway"
                ;;
            status)
                echo "running"
                ;;
            *)
                echo "unsupported gateway subcommand" >&2
                exit 1
                ;;
        esac
        ;;
    *)
        echo "unsupported openclaw command: ${cmd}" >&2
        exit 1
        ;;
esac
EOF
chmod +x "${FAKE_BIN}/openclaw"

cat > "${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

STATE_DIR="${FAKE_DOCKER_STATE_DIR:?}"
ACP_PORT="${ACP_PORT:-3100}"
mkdir -p "${STATE_DIR}"

listener_pid_file="${STATE_DIR}/listener.pid"

start_listener() {
    if [[ -f "${listener_pid_file}" ]] && kill -0 "$(cat "${listener_pid_file}")" 2>/dev/null; then
        return 0
    fi

    python3 - "${ACP_PORT}" > /dev/null 2>&1 <<'PYEOF' &
import socket, sys, time
port = int(sys.argv[1])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
try:
    while True:
        try:
            conn, _ = s.accept()
            conn.close()
        except Exception:
            time.sleep(0.1)
except KeyboardInterrupt:
    pass
PYEOF
    echo $! > "${listener_pid_file}"
}

stop_listener() {
    if [[ -f "${listener_pid_file}" ]]; then
        kill "$(cat "${listener_pid_file}")" 2>/dev/null || true
        rm -f "${listener_pid_file}"
    fi
}

cmd="${1:-}"
shift || true

case "${cmd}" in
    --version)
        echo "Docker version 25.0.0, build test"
        ;;
    info)
        if [[ "${1:-}" == "-f" ]]; then
            echo "/var/lib/docker"
        else
            echo "fake docker info"
        fi
        ;;
    load)
        cat >/dev/null
        echo "loaded" > "${STATE_DIR}/image-latest"
        ;;
    image)
        sub="${1:-}"
        shift || true
        case "${sub}" in
            inspect)
                [[ -f "${STATE_DIR}/image-latest" || -f "${STATE_DIR}/rollback-image" ]] || exit 1
                if [[ "${1:-}" == "--format" ]]; then
                    shift 2 || true
                fi
                ref="${1:-}"
                if [[ "${ref}" == *rollback* ]]; then
                    echo "sha256:rollback"
                else
                    echo "sha256:latest"
                fi
                ;;
            ls)
                [[ -f "${STATE_DIR}/image-latest" ]] && echo "hermes-agent:latest"
                [[ -f "${STATE_DIR}/rollback-image" ]] && echo "hermes-agent:rollback"
                ;;
            *)
                exit 1
                ;;
        esac
        ;;
    ps)
        if printf '%s\n' "$*" | grep -q -- '-a'; then
            [[ -f "${STATE_DIR}/container" ]] && echo "hermes-agent"
        else
            if [[ -f "${STATE_DIR}/container" ]]; then
                if printf '%s\n' "$*" | grep -q -- '{{.Status}}'; then
                    echo "Up 1 second"
                else
                    echo "hermes-agent"
                fi
            fi
        fi
        ;;
    rm)
        shift || true
        rm -f "${STATE_DIR}/container"
        stop_listener
        ;;
    rmi)
        shift || true
        rm -f "${STATE_DIR}/image-latest" "${STATE_DIR}/rollback-image"
        ;;
    tag)
        echo "rollback" > "${STATE_DIR}/rollback-image"
        ;;
    run)
        echo "container" > "${STATE_DIR}/container"
        start_listener
        ;;
    restart)
        start_listener
        ;;
    exec)
        shift || true
        if [[ "${1:-}" == "hermes-agent" ]]; then
            shift || true
        fi
        if printf '%s\n' "$*" | grep -q 'hermes version'; then
            echo "Hermes Agent v0.9.0"
            exit 0
        fi
        exit 0
        ;;
    logs)
        echo "Hermes gateway started"
        ;;
    *)
        echo "unsupported docker command: ${cmd}" >&2
        exit 1
        ;;
esac
EOF
chmod +x "${FAKE_BIN}/docker"

cat > "${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${*}" == *"http://100.96.0.96/latest/region_id"* ]]; then
    exit 1
fi

dest=""
url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            dest="$2"
            shift 2
            ;;
        -f|-S|-s|-L|--connect-timeout|--max-time)
            if [[ "$1" == --connect-timeout || "$1" == --max-time ]]; then
                shift 2
            else
                shift
            fi
            ;;
        *)
            url="$1"
            shift
            ;;
    esac
done

[[ -n "${dest}" && -n "${url}" ]] || exit 1
cp "${url#file://}" "${dest}"
EOF
chmod +x "${FAKE_BIN}/curl"

assert_json() {
    local file="$1" code="$2" message="$3"
    python3 - "$file" "$message" "$code" <<'PYEOF'
import json, sys
file_path, message, expr = sys.argv[1], sys.argv[2], sys.argv[3]
with open(file_path) as f:
    data = json.load(f)
if not eval(expr, {"data": data}):
    raise SystemExit(message)
PYEOF
}

make_config() {
    local path="$1"
    cat > "${path}" <<'EOF'
{
  "plugins": { "entries": {} },
  "agents": {
    "defaults": {
      "model": { "primary": "openai/gpt-4.1" },
      "models": {}
    }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-test",
        "models": [
          { "id": "gpt-4.1" }
        ]
      }
    }
  }
}
EOF
}

run_case() {
    local name="$1" openclaw_version="$2" preseed_mode="$3"
    local case_root="${TEST_ROOT}/${name}"
    local cfg="${case_root}/openclaw.json"
    local ext="${case_root}/extensions"
    local data_dir="${case_root}/hermes-data"
    local cache_dir="${case_root}/cache"
    local log_dir="${case_root}/logs"
    local fake_state="${case_root}/fake-state"

    mkdir -p "${case_root}" "${ext}" "${cache_dir}" "${log_dir}" "${fake_state}"
    make_config "${cfg}"

    if [[ "${preseed_mode}" == "legacy" ]]; then
        mkdir -p "${ext}/openclaw-plugin-hermes"
        echo legacy > "${ext}/openclaw-plugin-hermes/legacy.txt"
        python3 - "${cfg}" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
data["plugins"]["entries"]["openclaw-plugin-hermes"] = {
    "enabled": True,
    "config": {
        "hermesContainerName": "old-hermes",
        "defaultModel": "old-model"
    }
}
data["models"]["providers"]["hermes"] = {
    "baseUrl": "http://old-runtime",
    "apiKey": "old",
    "models": [{"id": "old"}]
}
data["agents"]["defaults"]["models"]["hermes/default"] = {"alias": "old-hermes"}
with open(sys.argv[1], "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
PYEOF
    fi

    local image_tar="${case_root}/image.tar.gz"
    printf 'fake-image' > "${image_tar}"

    export PATH="${FAKE_BIN}:${PATH}"
    export FAKE_OPENCLAW_STATE_DIR="${fake_state}/openclaw"
    export FAKE_DOCKER_STATE_DIR="${fake_state}/docker"
    export FAKE_OPENCLAW_VERSION="${openclaw_version}"
    export OPENCLAW_CONFIG="${cfg}"
    export OPENCLAW_EXTENSIONS_DIR="${ext}"
    export DATA_DIR="${data_dir}"
    export DOWNLOAD_CACHE_DIR="${cache_dir}"
    export LOG_DIR="${log_dir}"
    export TOS_IMAGE_URL="file://${image_tar}"
    export ACP_PORT=3100
    export MIN_FREE_SPACE_GB=1

    bash "${INSTALL_V2}"

    [[ -d "${ext}/openclaw-plugin-hermes" ]] || { echo "[${name}] openclaw-plugin-hermes 插件目录不存在" >&2; return 1; }
    [[ ! -d "${ext}/hermes" ]] || { echo "[${name}] 旧 hermes 插件目录仍存在" >&2; return 1; }
    [[ -f "${data_dir}/.env" ]] || { echo "[${name}] .env 未生成" >&2; return 1; }

    assert_json "${cfg}" 'data["plugins"]["entries"].get("openclaw-plugin-hermes", {}).get("enabled") is True' "[${name}] 插件启用状态错误"
    assert_json "${cfg}" 'data["models"]["providers"].get("hermes", {}).get("baseUrl") == "http://127.0.0.1/hermes-runtime"' "[${name}] hermes provider 未写入"
    assert_json "${cfg}" 'data["agents"]["defaults"]["models"].get("hermes/default", {}).get("alias") == "hermes"' "[${name}] hermes/default alias 未写入"

    bash "${INSTALL_V2}"
    assert_json "${cfg}" 'data["plugins"]["entries"].get("openclaw-plugin-hermes", {}).get("config", {}).get("hermesContainerName") == "hermes-agent"' "[${name}] 重复安装后 hermesContainerName 不正确"
    if grep -q 'Provider: hermes' "${log_dir}"/upgrade-*.log; then
        echo "[${name}] 重复安装错误读取了合成 hermes provider" >&2
        return 1
    fi

    bash "${UNINSTALL_V2}" --yes

    [[ ! -d "${ext}/openclaw-plugin-hermes" ]] || { echo "[${name}] 卸载后 openclaw-plugin-hermes 插件目录仍存在" >&2; return 1; }
    [[ ! -e "${data_dir}" ]] || { echo "[${name}] 卸载后数据目录仍存在" >&2; return 1; }
    assert_json "${cfg}" '"openclaw-plugin-hermes" not in data["plugins"]["entries"]' "[${name}] 卸载后插件配置未清理"
    assert_json "${cfg}" '"hermes" not in data["models"]["providers"]' "[${name}] 卸载后 provider 未清理"
    assert_json "${cfg}" '"hermes/default" not in data["agents"]["defaults"]["models"]' "[${name}] 卸载后 alias 未清理"
}

run_low_version_case() {
    local case_root="${TEST_ROOT}/low-version"
    local cfg="${case_root}/openclaw.json"
    local ext="${case_root}/extensions"
    local fake_state="${case_root}/fake-state"
    local image_tar="${case_root}/image.tar.gz"
    mkdir -p "${case_root}" "${ext}" "${fake_state}"
    make_config "${cfg}"
    printf 'fake-image' > "${image_tar}"

    export PATH="${FAKE_BIN}:${PATH}"
    export FAKE_OPENCLAW_STATE_DIR="${fake_state}/openclaw"
    export FAKE_DOCKER_STATE_DIR="${fake_state}/docker"
    export FAKE_OPENCLAW_VERSION="OpenClaw 2026.4.14 (test)"
    export OPENCLAW_CONFIG="${cfg}"
    export OPENCLAW_EXTENSIONS_DIR="${ext}"
    export DATA_DIR="${case_root}/hermes-data"
    export DOWNLOAD_CACHE_DIR="${case_root}/cache"
    export LOG_DIR="${case_root}/logs"
    export TOS_IMAGE_URL="file://${image_tar}"
    export MIN_FREE_SPACE_GB=1

    if bash "${INSTALL_V2}" >/tmp/install-v2-low-version.log 2>&1; then
        echo "[low-version] 低版本 OpenClaw 未被拒绝" >&2
        return 1
    fi
    grep -q "2026.4.15" /tmp/install-v2-low-version.log || {
        echo "[low-version] 错误信息未包含最低版本要求" >&2
        return 1
    }
}

run_case "fresh-install" "OpenClaw 2026.4.15 (test)" "fresh"
run_case "legacy-upgrade" "OpenClaw 2026.4.15 (test)" "legacy"
run_low_version_case

echo "OK install-v2/uninstall-v2 regression suite passed"

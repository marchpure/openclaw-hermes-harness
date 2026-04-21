#!/usr/bin/env bash
set -Eeuo pipefail

BASE_INSTALL_SCRIPT_URL="${BASE_INSTALL_SCRIPT_URL:-https://zhuhaoliang-test.tos-cn-beijing.volces.com/hermes-install-0417.sh}"
TOS_IMAGE_URL="${TOS_IMAGE_URL:-https://zhuhaoliang-test.tos-cn-beijing.volces.com/hermes-agent-image.tar.gz}"
TOS_PLUGIN_URL="${TOS_PLUGIN_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com/openclaw-plugin-hermes-acp-agent.tgz}"
OPENCLAW_CONFIG="/root/.openclaw/openclaw.json"
ACPX_CONFIG_DIR="/root/.acpx"
ACPX_CONFIG_PATH="${ACPX_CONFIG_DIR}/config.json"
HERMES_AGENT_ALIAS="${HERMES_AGENT_ALIAS:-hermes}"
HERMES_CONTAINER_NAME="${HERMES_CONTAINER_NAME:-hermes-agent}"
PLUGIN_CONFIG_KEY="${PLUGIN_CONFIG_KEY:-hermes}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

patch_openclaw_config() {
  python3 - "$OPENCLAW_CONFIG" "$PLUGIN_CONFIG_KEY" "$HERMES_CONTAINER_NAME" "$HERMES_AGENT_ALIAS" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
pk = sys.argv[2]
container = sys.argv[3]
alias = sys.argv[4]

data = json.loads(path.read_text())
plugins = data.setdefault('plugins', {}).setdefault('entries', {})
hermes = plugins.setdefault(pk, {})
hermes['enabled'] = True
cfg = hermes.setdefault('config', {})
cfg['hermesContainerName'] = container
cfg['transport'] = 'tcp'
cfg['tcpHost'] = '127.0.0.1'
cfg['tcpPort'] = 3100
cfg['autoStrategy'] = True
cfg['enableLayeredProtocol'] = True
cfg['timeout'] = cfg.get('timeout', 1800)
cfg['acpAgentEnabled'] = True
cfg['acpAgentAlias'] = alias

plugins.setdefault('acpx', {'enabled': True})
plugins['acpx']['enabled'] = True
acpx_cfg = plugins['acpx'].setdefault('config', {})
acpx_cfg.setdefault('permissionMode', 'approve-all')
acpx_cfg.setdefault('nonInteractivePermissions', 'deny')

acp = data.setdefault('acp', {})
acp['enabled'] = True
acp_dispatch = acp.setdefault('dispatch', {})
acp_dispatch['enabled'] = True
acp['backend'] = 'acpx'
allowed = acp.setdefault('allowedAgents', [])
if alias not in allowed:
    allowed.append(alias)

session = data.setdefault('session', {})
thread_bindings = session.setdefault('threadBindings', {})
thread_bindings['enabled'] = True
thread_bindings.setdefault('idleHours', 24)
thread_bindings.setdefault('maxAgeHours', 0)

channels = data.setdefault('channels', {})
for channel_name in ('discord', 'telegram'):
    channel = channels.setdefault(channel_name, {})
    tb = channel.setdefault('threadBindings', {})
    tb['enabled'] = True
    tb['spawnAcpSessions'] = True

path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY
}

write_acpx_config() {
  mkdir -p "$ACPX_CONFIG_DIR"
  python3 - "$ACPX_CONFIG_PATH" "$HERMES_AGENT_ALIAS" "$HERMES_CONTAINER_NAME" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
alias = sys.argv[2]
container = sys.argv[3]
command = f"docker exec -i {container} hermes acp"

if path.exists():
    try:
        data = json.loads(path.read_text())
    except Exception:
        data = {}
else:
    data = {}

agents = data.setdefault('agents', {})
agent = agents.setdefault(alias, {})
agent['command'] = command

path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY
}

main() {
  require_cmd curl
  require_cmd python3
  require_cmd openclaw

  local work_dir
  local base_script
  local patched_script
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermes-install-acp-agent.XXXXXX")"
  trap "rm -rf '${work_dir}'" EXIT
  base_script="${work_dir}/hermes-install-base.sh"
  patched_script="${work_dir}/hermes-install-patched.sh"

  log "Using Hermes image: ${TOS_IMAGE_URL}"
  log "Using Hermes plugin: ${TOS_PLUGIN_URL}"
  log "Downloading base installer: ${BASE_INSTALL_SCRIPT_URL}"

  curl -fsSL "${BASE_INSTALL_SCRIPT_URL}" -o "${base_script}"
  [[ -s "${base_script}" ]] || die "failed to download base installer"

  python3 - "${base_script}" "${patched_script}" <<'PY'
from pathlib import Path
import sys

src = Path(sys.argv[1]).read_text()
old = '    log_info "执行 openclaw plugins install ${plugin_path}"\n    openclaw plugins install "${plugin_path}"\n'
new = '    log_info "执行 openclaw plugins install ${plugin_path} --dangerously-force-unsafe-install --force"\n    openclaw plugins install "${plugin_path}" --dangerously-force-unsafe-install --force\n'
if old not in src:
    raise SystemExit('failed to patch installer plugin install block')
src = src.replace(old, new, 1)
Path(sys.argv[2]).write_text(src)
PY

  chmod +x "${patched_script}"
  export TOS_IMAGE_URL
  export TOS_PLUGIN_URL

  log "Running base installer"
  bash "${patched_script}" "$@"

  [[ -f "$OPENCLAW_CONFIG" ]] || die "missing OpenClaw config: $OPENCLAW_CONFIG"

  log "Patching OpenClaw config for ACP agent flow"
  patch_openclaw_config

  log "Writing ~/.acpx/config.json for Hermes ACP agent alias"
  write_acpx_config

  log "Restarting OpenClaw gateway"
  openclaw gateway restart || true

  log "Done. Recommended commands:"
  log "  /acp spawn ${HERMES_AGENT_ALIAS} --bind here"
  log "  /acp spawn ${HERMES_AGENT_ALIAS} --thread auto"
}

main "$@"

#!/usr/bin/env bash
set -Eeuo pipefail

BASE_INSTALL_SCRIPT_URL="${BASE_INSTALL_SCRIPT_URL:-https://zhuhaoliang-test.tos-cn-beijing.volces.com/hermes-install-0417.sh}"
TOS_IMAGE_URL="${TOS_IMAGE_URL:-https://zhuhaoliang-test.tos-cn-beijing.volces.com/hermes-agent-image.tar.gz}"
TOS_PLUGIN_URL="${TOS_PLUGIN_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com/openclaw-plugin-hermes-1.0.0-webui-event-bridge-20260422-191810.tgz}"

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

main() {
  require_cmd curl
  require_cmd python3

  local work_dir
  local base_script
  local patched_script
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermes-install-tool-runtime-acp.XXXXXX")"
  trap "rm -rf '${work_dir}'" EXIT
  base_script="${work_dir}/hermes-install-base.sh"
  patched_script="${work_dir}/hermes-install-patched.sh"

  log "Using Hermes image: ${TOS_IMAGE_URL}"
  log "Using Hermes ACP plugin: ${TOS_PLUGIN_URL}"

  local openclaw_config="${OPENCLAW_CONFIG:-${HOME}/.openclaw/openclaw.json}"
  if [[ -f "${openclaw_config}" ]]; then
    log "Pre-cleaning legacy Hermes runtimeMode from ${openclaw_config} if present"
    python3 - "${openclaw_config}" <<'PYEOF'
import json
from pathlib import Path
import shutil
import sys
import time

path = Path(sys.argv[1]).expanduser()
try:
    data = json.loads(path.read_text())
except Exception:
    raise SystemExit(0)

cfg = (((data.get('plugins') or {}).get('entries') or {}).get('hermes') or {}).get('config')
if isinstance(cfg, dict) and 'runtimeMode' in cfg:
    backup = path.with_name(f"{path.name}.hermes-runtimeMode-clean-{int(time.time())}.bak")
    shutil.copy2(path, backup)
    cfg.pop('runtimeMode', None)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PYEOF
  fi

  log "Downloading base installer: ${BASE_INSTALL_SCRIPT_URL}"

  curl -fsSL "${BASE_INSTALL_SCRIPT_URL}" -o "${base_script}"
  [[ -s "${base_script}" ]] || die "failed to download base installer"

  python3 - "${base_script}" "${patched_script}" <<'PY'
from pathlib import Path
import re
import sys

src = Path(sys.argv[1]).read_text()

old_install = """    if [[ -f \"${plugin_path}\" ]]; then
        remove_installed_plugin_directories
    fi

    log_info \"执行 openclaw plugins install ${plugin_path}\"
    openclaw plugins install \"${plugin_path}\"
    log_info \"插件安装完成\"
"""
new_install = """    if [[ -f \"${plugin_path}\" ]]; then
        remove_installed_plugin_directories
        rm -rf \"${CACHE_DIR}/hermes-plugin-extract\"
        log_info \"保留插件 tgz 归档交给 OpenClaw 原生安装，避免手动解压后被误判为 hook dir\"
    fi

    log_info \"执行 openclaw plugins install ${plugin_path} --dangerously-force-unsafe-install --force\"
    openclaw plugins install \"${plugin_path}\" --dangerously-force-unsafe-install --force
    log_info \"插件安装完成\"
"""
if old_install not in src:
    raise SystemExit("failed to patch base installer: install block not found")
src = src.replace(old_install, new_install, 1)

old_cfg = """        jq --arg cn "${CONTAINER_NAME}" --arg dm "${DEFAULT_MODEL_VAL}" \\
           --arg pk "${PLUGIN_CONFIG_KEY}" \\
           '.plugins.entries[$pk].config = {
               "hermesContainerName": $cn,
               "defaultModel": $dm,
               "autoStrategy": true,
               "enableLayeredProtocol": false,
               "timeout": 1800
           } | .plugins.entries[$pk].enabled = true' "${OPENCLAW_CONFIG}" > "${tmp}" \\
           && mv "${tmp}" "${OPENCLAW_CONFIG}"
"""
new_cfg = """        jq --arg cn "${CONTAINER_NAME}" --arg dm "${DEFAULT_MODEL_VAL}" \\
           --arg pk "${PLUGIN_CONFIG_KEY}" \\
           '.plugins.entries[$pk].config = {
               "hermesContainerName": $cn,
               "defaultModel": $dm,
               "autoStrategy": true,
               "enableLayeredProtocol": false,
               "timeout": 1800
           }
           | .plugins.entries[$pk].enabled = true
           | .agents.defaults.models = ((.agents.defaults.models // {}) + {
               "hermes/default": {
                 "alias": "hermes"
               }
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
             }' "${OPENCLAW_CONFIG}" > "${tmp}" \\
           && mv "${tmp}" "${OPENCLAW_CONFIG}"
"""
if old_cfg not in src:
    raise SystemExit("failed to patch base installer config jq block")
src = src.replace(old_cfg, new_cfg, 1)

old_cfg_done = """    log_info \"插件配置已写入\"

    update_config_yaml || log_info \"config.yaml 尚未生成，将在容器首次启动后由 entrypoint 创建\"
}
"""
new_cfg_done = """    log_info \"插件配置已写入\"

    log_info \"清理默认 main 会话中的旧模型覆盖，确保 hermes/default 生效\"
    python3 - \"${OPENCLAW_CONFIG}\" <<'PYEOF'
import json
from pathlib import Path
import shutil
import sys
import time

config_path = Path(sys.argv[1])
state_dir = config_path.parent
sessions_path = state_dir / 'agents' / 'main' / 'sessions' / 'sessions.json'
if not sessions_path.exists():
    raise SystemExit(0)

try:
    data = json.loads(sessions_path.read_text())
except Exception:
    raise SystemExit(0)

if not isinstance(data, dict):
    raise SystemExit(0)

changed = False
target_keys = ['agent:main:main']
for key in target_keys:
    entry = data.get(key)
    if not isinstance(entry, dict):
        continue
    for field in ('providerOverride', 'modelOverride'):
        value = entry.get(field)
        if isinstance(value, str) and value.strip():
            entry[field] = ''
            changed = True
    for field in ('modelProvider', 'model'):
        value = entry.get(field)
        if isinstance(value, str) and value.strip() and value.strip() != 'hermes' and field == 'modelProvider':
            entry[field] = 'hermes'
            changed = True
        elif isinstance(value, str) and value.strip() and value.strip() != 'default' and field == 'model':
            entry[field] = 'default'
            changed = True

if changed:
    backup = sessions_path.with_name(f"sessions.json.hermes-upgrade-{int(time.time())}.bak")
    shutil.copy2(sessions_path, backup)
    sessions_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\\n')
PYEOF

    update_config_yaml || log_info \"config.yaml 尚未生成，将在容器首次启动后由 entrypoint 创建\"
}
"""
if old_cfg_done not in src:
    raise SystemExit("failed to patch base installer session cleanup block")
src = src.replace(old_cfg_done, new_cfg_done, 1)

py_pattern = re.compile(
    r"hermes = d\.setdefault\('plugins', \{\}\)\.setdefault\('entries', \{\}\)\.setdefault\(pk, \{\}\)\n"
    r"hermes\['enabled'\] = True\n"
    r"hermes\['config'\] = \{\n"
    r"    'hermesContainerName': cn,\n"
    r"    'defaultModel': dm,\n"
    r"    'autoStrategy': True,\n"
    r"    'enableLayeredProtocol': False,\n"
    r"    'timeout': 1800\n"
    r"\}\n"
    r"with open\(cf, 'w'\) as f:\n"
    r"    json\.dump\(d, f, indent=2, ensure_ascii=False\)\n",
    re.M,
)
new_py = """hermes = d.setdefault('plugins', {}).setdefault('entries', {}).setdefault(pk, {})
hermes['enabled'] = True
hermes['config'] = {
    'hermesContainerName': cn,
    'defaultModel': dm,
    'autoStrategy': True,
    'enableLayeredProtocol': False,
    'timeout': 1800
}
agents = d.setdefault('agents', {}).setdefault('defaults', {})
allow_models = agents.setdefault('models', {})
allow_models['hermes/default'] = {
    'alias': 'hermes'
}
providers = d.setdefault('models', {}).setdefault('providers', {})
providers['hermes'] = {
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
            'maxTokens': 32000
        }
    ]
}
with open(cf, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
"""
src, py_count = py_pattern.subn(new_py, src, count=1)
if py_count != 1:
    raise SystemExit("failed to patch base installer config python block")

Path(sys.argv[2]).write_text(src)
PY
  [[ -s "${patched_script}" ]] || die "failed to patch base installer"
  chmod +x "${patched_script}"

  export TOS_IMAGE_URL
  export TOS_PLUGIN_URL

  log "Starting base installer with Hermes ACP plugin artifact"
  bash "${patched_script}" "$@"
}

main "$@"

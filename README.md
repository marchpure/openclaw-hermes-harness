# openclaw-hermes-harness

OpenClaw plugin for delegating heavy execution work to a containerized Hermes Agent via ACP.

The plugin registers:

- `hermes` model provider metadata.
- `hermes` agent harness for Hermes-managed attempts.
- `hermes_dispatch`, `hermes_status`, and `hermes_strategy` agent tools.

## Install

```bash
openclaw plugins install git+ssh://git@github.com/marchpure/openclaw-hermes-harness.git
```

## Configure

```json
{
  "plugins": {
    "entries": {
      "hermes": {
        "enabled": true,
        "config": {
          "hermesContainerName": "hermes-agent",
          "transport": "tcp",
          "tcpHost": "127.0.0.1",
          "tcpPort": 3100,
          "defaultModel": "default",
          "autoStrategy": true
        }
      }
    }
  }
}
```

## Development

```bash
npm install
npm test
npm run typecheck
```

Hermes runtime tests that call the real container require Docker and a running `hermes-agent`
container. Unit tests mock the OpenClaw plugin API and do not require Hermes to be running.

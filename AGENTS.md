# AGENTS.md - Architecture Overview

## Project Overview

**openclaw-plugin-hermes** is an OpenClaw plugin that delegates heavy computational tasks (terminal operations, browser automation, code execution) to a containerized Hermes Agent via the Agent Client Protocol (ACP). The plugin acts as a bridge between OpenClaw (the orchestrator) and Hermes (the execution agent), implementing a sophisticated three-dimensional dispatch protocol for task delegation.

### Core Architecture

The plugin follows a pipeline architecture where each task flows through:

1. **Strategy Engine** - Determines execution parameters (L/C/W triple)
2. **Context Assembler** - Builds context payload based on context level
3. **Credential Injector** - Injects scoped credentials into environment
4. **ACP Client** - Communicates with Hermes via JSON-RPC
5. **Result Processor** - Handles writeback of results to OpenClaw

### Three-Dimensional Dispatch Protocol

Every task dispatch is controlled along three orthogonal dimensions:

**Context Level (L0-L3)**: How much Hermes knows
- L0: Stateless (task + model config only)
- L1: Tools (tool config, command allowlist, browser config)
- L2: Context (memory, identity, workspace instructions)
- L3: Full Sync (skills, MCP servers, cron definitions)

**Credential Scope (C0-C2)**: What services Hermes can access
- C0: No credentials
- C1: Specified credentials only
- C2: All credentials (requires user confirmation)

**Writeback Level (W0-W3)**: What gets written back to OpenClaw
- W0: No writeback (query only)
- W1: Return result text
- W2: Update memory
- W3: Create skills/cron/config (requires confirmation)

## Build & Commands

### Development Setup
```bash
npm install                    # Install dependencies
npx tsx test-e2e.ts           # Run end-to-end tests
```

### Build
```bash
npx tsc                       # Compile TypeScript to dist/
```

### Testing
The project uses a single E2E test file (`test-e2e.ts`) that validates:
- Container health check
- Strategy inference accuracy
- Context assembly for different levels
- Credential injection logic
- ACP communication end-to-end

**Prerequisites for testing**:
- Docker running with `hermes-agent` container
- Container accessible via `docker exec`

### Deployment
The plugin is loaded by OpenClaw through the `openclaw.plugin.json` manifest. No separate build step is required for development - OpenClaw loads TypeScript files directly via the `openclaw.extensions` field in `package.json`.

## Code Style

### TypeScript Configuration
- Target: ES2022
- Module: ESNext with ESNext module resolution
- Strict mode enabled
- ES module interop enabled
- Source maps and declarations generated

### Naming Conventions
- **Files**: kebab-case (e.g., `strategy-engine.ts`, `acp-client.ts`)
- **Classes**: PascalCase (e.g., `HermesAcpClient`)
- **Functions/Variables**: camelCase (e.g., `inferStrategy`, `assembleContext`)
- **Constants**: SCREAMING_SNAKE_CASE for global constants (e.g., `CREDENTIAL_REGISTRY`, `MEMORY_FULL_THRESHOLD_CHARS`)
- **Types/Interfaces**: PascalCase (e.g., `DispatchRequest`, `StrategyTriple`)

### File Organization
Each module in `src/` has a single responsibility:
- `index.ts` - Plugin entry point, registers tools with OpenClaw API
- `types.ts` - Type definitions and constants
- `dispatcher.ts` - Core orchestrator coordinating all components
- `strategy-engine.ts` - L/C/W strategy inference from task text
- `context-assembler.ts` - Context payload construction
- `credential-injector.ts` - Credential scoping and injection
- `acp-client.ts` - ACP JSON-RPC client (TCP and stdio transports)
- `result-processor.ts` - Result writeback handling
- `health.ts` - Container health verification

### Code Patterns
- Async/await for all asynchronous operations
- EventEmitter pattern for streaming events (ACP client)
- Factory functions for configuration objects
- Regex-based pattern matching for strategy inference
- Functional approach for data transformation

## Testing

### Test Structure
The E2E test (`test-e2e.ts`) is organized into 5 sequential tests:

1. **Health Check** - Verifies Hermes container is running and ACP is responsive
2. **Strategy Inference** - Tests automatic L/C/W detection for various task types
3. **Context Assembly** - Validates context payload construction for L0-L2 levels
4. **Credential Injection** - Tests C0/C1 credential scoping
5. **ACP E2E** - Full end-to-end communication test with Hermes

### Running Tests
```bash
# Ensure Hermes container is running first
docker ps | grep hermes-agent

# Run E2E tests
npx tsx test-e2e.ts
```

### Test Configuration
Tests use `DEFAULT_CONFIG` from `types.ts` with:
- Container name: `hermes-agent`
- Timeout: 60 seconds
- Transport: TCP (default) or stdio

### Adding New Tests
When adding new functionality:
1. Add test cases to the appropriate section in `test-e2e.ts`
2. Test both success and error paths
3. Verify strategy inference accuracy for new task patterns
4. Test credential injection for new service integrations

## Security

### Credential Management
- **Never written to disk**: Credentials are injected via environment variables (`docker exec -e`)
- **Scoped access**: C0/C1/C2 levels control what credentials Hermes receives
- **Audit logging**: Every credential injection is logged with timestamp and masked values
- **Masking**: Credential values are masked in logs (first 4 + last 4 chars)

### Credential Registry
Known credentials are defined in `CREDENTIAL_REGISTRY` (src/credential-injector.ts:23-51):
- LLM providers: OpenAI, Anthropic, Google, OpenRouter, Minimax
- Messaging: Telegram, Discord, Slack, WhatsApp
- Services: GitHub, Home Assistant, Email
- Media/AI: Fal, ElevenLabs
- Cloud: AWS, Volcengine

### Container Isolation
- Hermes runs in a Docker container with restricted permissions
- Read-only filesystem recommended
- No new privileges flag should be set
- Container resource usage is monitored via health checks

### User Confirmation Requirements
W3 writeback operations (skill/cron creation) require explicit user confirmation via `confirmAction` callback. If no callback is provided, these operations are blocked.

### Security Best Practices
1. Default to C0 (no credentials) - only upgrade when necessary
2. Use C1 with specific keys rather than C2 (all credentials)
3. Always log credential injection for audit trails
4. Validate container status before executing tasks
5. Implement timeouts to prevent runaway operations

## Configuration

### Plugin Configuration Schema
Configuration is defined in `openclaw.plugin.json` with the following options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hermesCommand` | string | - | Custom hermes-acp command |
| `hermesContainerName` | string | `hermes-agent` | Docker container name |
| `hermesDataDir` | string | - | Host path for Hermes data |
| `defaultModel` | string | - | Default LLM model |
| `defaultContextLevel` | L0-L3 | `L1` | Default context level |
| `defaultCredentialScope` | C0-C2 | `C0` | Default credential scope |
| `defaultWriteback` | W0-W3 | `W1` | Default writeback level |
| `timeout` | number | `300` | Task timeout in seconds |
| `autoStrategy` | boolean | `true` | Enable auto strategy inference |
| `transport` | tcp/stdio | `tcp` | ACP transport mode |
| `tcpHost` | string | `127.0.0.1` | TCP host for ACP bridge |
| `tcpPort` | number | `3100` | TCP port for ACP bridge |

### OpenClaw Integration
Add to OpenClaw configuration:
```json
{
  "plugins": {
    "entries": {
      "hermes": {
        "enabled": true,
        "config": {
          "hermesContainerName": "hermes-agent",
          "defaultModel": "minimax-m2.5",
          "autoStrategy": true,
          "timeout": 300
        }
      }
    }
  }
}
```

### Transport Modes
- **TCP (recommended)**: Persistent connection to Hermes ACP bridge on port 3100
- **stdio**: Spawns `hermes acp` via `docker exec` for each task

### Workspace Files
The plugin reads from the OpenClaw workspace directory:
- `SOUL.md` - Agent identity and personality
- `USER.md` - User profile and preferences
- `AGENTS.md` - Workspace-specific instructions
- `MEMORY.md` - Long-term memory (truncated at L2, full at L3)
- `memory/YYYY-MM-DD.md` - Daily notes
- `exec-approvals.json` - Command allowlist
- `skills/` - Skill definitions (L3 only)

### Context Assembly Rules
- L0: Minimal payload (task + model)
- L1: Add tool config and command allowlist
- L2: Add memory (truncated to ~2K tokens), identity files, daily notes
- L3: Full memory, skills manifest, MCP servers, cron definitions

Memory truncation uses adaptive summarization that keeps recent sections when exceeding 5500 characters (~2K tokens).

## Registered Tools

### hermes_dispatch
Delegates a task to Hermes for execution. Supports automatic strategy inference or explicit L/C/W parameters.

**Key parameters**:
- `task` (required): Natural language task description
- `contextLevel`, `credentialScope`, `writeback`: Override auto-detected strategy
- `credentialKeys`: Specific credentials for C1 scope
- `model`: Override LLM model
- `timeout`: Task timeout in seconds

### hermes_status
Checks Hermes container health, ACP responsiveness, version, and resource usage.

### hermes_strategy
Previews the auto-inferred L/C/W strategy for a task without executing it. Useful for debugging and understanding dispatch behavior.

## ACP Protocol

The plugin communicates with Hermes using JSON-RPC 2.0 over NDJSON (newline-delimited JSON):

**Methods**:
- `initialize` - Establish connection
- `session/new` - Create new session
- `session/prompt` - Send task and receive streaming events
- `session/cancel` - Cancel running task
- `session/close` - Close session

**Event Types**:
- `text` - Agent message chunk
- `thinking` - Agent thought process
- `tool_progress` - Tool call started
- `tool_result` - Tool execution result
- `done` - Task completed
- `error` - Error occurred

## Error Handling

- **Timeout**: Tasks exceeding timeout return status `timeout`
- **Execution errors**: Return status `error` with error message
- **Context assembly failures**: Return error result immediately
- **Result processing failures**: Non-fatal, logged as warnings
- **Connection failures**: Reject pending requests and emit error events

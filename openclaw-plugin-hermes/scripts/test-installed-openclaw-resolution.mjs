import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const require = createRequire(import.meta.url);
const openclawDist = "/usr/lib/node_modules/openclaw/dist";
const gatewayBundle = `${openclawDist}/gateway-request-scope-Dkin09LL.js`;
const agentBundle = `${openclawDist}/agent-events-BLJ1mmc3.js`;

const webuiSource = readFileSync(new URL("../src/webui-event-bridge.ts", import.meta.url), "utf8");
const agentSource = readFileSync(new URL("../src/agent-event-bridge.ts", import.meta.url), "utf8");

assert(
  webuiSource.includes("/usr/lib/node_modules/openclaw/dist"),
  "webui-event-bridge must keep global OpenClaw dist fallback for installed runtimes",
);
assert(
  agentSource.includes("/usr/lib/node_modules/openclaw/dist"),
  "agent-event-bridge must keep global OpenClaw dist fallback for installed runtimes",
);

const gatewayMod = await import(`file://${gatewayBundle}`);
const gatewayReader = gatewayMod.getPluginRuntimeGatewayRequestScope ?? gatewayMod.t;
assert(typeof gatewayReader === "function", "installed gateway-request-scope bundle must expose a reader");

const agentMod = await import(`file://${agentBundle}`);
const agentEmitter = agentMod.emitAgentEvent ?? agentMod.i;
assert(typeof agentEmitter === "function", "installed agent-events bundle must expose an emitter");

try {
  require.resolve("openclaw/plugin-sdk/agent-harness");
  console.log(JSON.stringify({
    ok: true,
    note: "sdk package path is directly resolvable on this machine",
  }, null, 2));
} catch {
  console.log(JSON.stringify({
    ok: true,
    note: "sdk package path is not directly resolvable; installed OpenClaw dist fallback is required",
    verifiedBundles: [gatewayBundle, agentBundle],
  }, null, 2));
}

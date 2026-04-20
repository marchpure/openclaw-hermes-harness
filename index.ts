import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createHermesAgentHarness } from "./harness.js";
import { buildHermesProvider } from "./provider.js";
import { registerHermesTools } from "./tools.js";

export default definePluginEntry({
  id: "hermes",
  name: "Hermes",
  description: "Hermes agent runtime harness and Hermes-managed model catalog.",
  register(api) {
    api.registerProvider(buildHermesProvider({ pluginConfig: api.pluginConfig }));
    api.registerAgentHarness(createHermesAgentHarness({ pluginConfig: api.pluginConfig }));
    registerHermesTools(api);
  },
});

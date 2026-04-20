export function createPluginApiStub() {
  return {
    pluginConfig: undefined,
    workspaceDir: "/tmp/hermes-workspace",
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    registerTool() {},
    registerProvider() {},
    registerAgentHarness() {},
  };
}

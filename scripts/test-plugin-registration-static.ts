import { readFile } from "node:fs/promises";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const provider = await readFile(new URL("../src/provider.ts", import.meta.url), "utf8");
  const harness = await readFile(new URL("../src/harness.ts", import.meta.url), "utf8");

  assert(
    index.includes("api.registerProvider?.(buildHermesProvider"),
    "plugin entry must register the Hermes provider",
  );
  assert(
    index.includes("api.registerAgentHarness?.(createHermesAgentHarness"),
    "plugin entry must register the Hermes agent harness",
  );
  assert(provider.includes('const PROVIDER_ID = "hermes"'), "provider id must stay hermes");
  assert(
    provider.includes('"http://127.0.0.1/hermes-runtime"'),
    "provider catalog should keep the legacy synthetic endpoint for model registration only",
  );
  assert(
    harness.includes('const DEFAULT_HERMES_HARNESS_PROVIDER_IDS = new Set(["hermes"])'),
    "harness must claim the hermes provider",
  );
  assert(
    harness.includes("createHermesRuntimeClient(") &&
      harness.includes("client.runAttempt(params)") &&
      harness.includes("clearHermesHarnessBinding"),
    "harness must execute through the Hermes runtime client and expose reset binding cleanup",
  );

  console.log("plugin registration static test: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

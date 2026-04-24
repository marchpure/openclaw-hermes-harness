import { readFile, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCredentialEnvelope } from "../src/credential-injector.js";
import { prepareProjectedExecutionEnv } from "../src/runtime-client.js";
import { DEFAULT_CONFIG, type CredentialScope, type HermesPluginConfig } from "../src/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-credential-envelope-"));
  await writeFile(join(workspace, "SOUL.md"), "You are a research assistant.", "utf8");
  await writeFile(join(workspace, "USER.md"), "User is Hao Xingjun.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Prefer factual output.", "utf8");
  await mkdir(join(workspace, "skills", "byted-web-search"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "byted-web-search", "SKILL.md"),
    "# Byted Web Search\n\nUse WEB_SEARCH_API_KEY for web lookup.",
    "utf8",
  );
  return workspace;
}

async function main() {
  const workspace = await createWorkspace();
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
  };
  const credentialScope: CredentialScope = { mode: "specified", keys: ["WEB_SEARCH_API_KEY"] };
  const envelope = buildCredentialEnvelope(credentialScope, {
    WEB_SEARCH_API_KEY: "ws_test_key_1234567890",
  });

  const execution = await prepareProjectedExecutionEnv({
    task: "Search current policy news",
    taskId: "task-credential-envelope",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
    credentialEnvelope: envelope,
  });

  const runtimeDir = join(execution.execEnv.hostExecEnvPath, ".openclaw");
  const manifestPath = join(runtimeDir, "credential-manifest.json");
  const envPath = join(runtimeDir, "credentials.env");

  assert(await stat(manifestPath).then((item) => item.isFile()).catch(() => false), "credential manifest should exist");
  assert(await stat(envPath).then((item) => item.isFile()).catch(() => false), "credential env file should exist");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string;
    scope: string;
    envFile: string;
    envKeys: string[];
  };
  const envText = await readFile(envPath, "utf8");

  assert(manifest.scope === "specified", "credential manifest should preserve scope");
  assert(manifest.envKeys.includes("WEB_SEARCH_API_KEY"), "credential manifest should list WEB_SEARCH_API_KEY");
  assert(manifest.envFile === ".openclaw/credentials.env", "credential manifest should point to env file");
  assert(envText.includes("WEB_SEARCH_API_KEY='ws_test_key_1234567890'"), "credential env file should materialize key");

  console.log("credential envelope test: ok");
  console.log(JSON.stringify({
    manifestPath,
    envPath,
    manifest,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

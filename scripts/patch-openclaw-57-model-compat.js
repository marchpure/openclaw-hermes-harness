#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const OPENCLAW_DIST_CANDIDATES = [
  process.env.OPENCLAW_DIST,
  "/usr/lib/node_modules/openclaw/dist",
  "/usr/local/lib/node_modules/openclaw/dist",
].filter(Boolean);

const BACKUP_SUFFIX = ".before-openclaw57-agent-harness-pin";
const LEGACY_HERMES_BACKUP_SUFFIX = ".before-hermes57";

function fail(message) {
  console.error(`[openclaw57] ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[openclaw57] ${message}`);
}

function findOpenClawDist() {
  for (const candidate of OPENCLAW_DIST_CANDIDATES) {
    const dist = path.resolve(candidate);
    if (fs.existsSync(dist) && findDistFile(dist, /^attempt-execution-.*\.js$/, "runAgentAttempt", false)) {
      return dist;
    }
  }
  fail("OpenClaw dist not found; set OPENCLAW_DIST=/path/to/openclaw/dist");
}

function findDistFile(dist, filePattern, contentNeedle, required = true) {
  const matches = fs.readdirSync(dist)
    .filter((name) => filePattern.test(name))
    .map((name) => path.join(dist, name));
  for (const file of matches) {
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(contentNeedle)) {
      return file;
    }
  }
  if (required) {
    fail(`OpenClaw dist file not found in ${dist}: ${filePattern} containing ${contentNeedle}`);
  }
  return undefined;
}

function backupOnce(file) {
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
}

function patchFile(file, transform) {
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after === before) {
    return false;
  }
  backupOnce(file);
  fs.writeFileSync(file, after);
  return true;
}

function restoreLegacyHermesPatchIfBackupExists(file) {
  const backup = `${file}${LEGACY_HERMES_BACKUP_SUFFIX}`;
  if (!fs.existsSync(backup)) {
    return false;
  }
  fs.copyFileSync(backup, file);
  return true;
}

function removeLegacyHermesModelOverridePatch(dist) {
  const file = findDistFile(dist, /^model-overrides-.*\.js$/, "hermes57-model-compat-v4", false);
  if (!file) {
    return false;
  }
  if (restoreLegacyHermesPatchIfBackupExists(file)) {
    return true;
  }
  return patchFile(file, (text) => {
    let next = text
      .replace(
        /\n+function hermes57ApplyModelRuntimeCompat\([\s\S]*?\n}\n\n\/\/#region src\/sessions\/model-overrides\.ts/,
        "\n//#region src/sessions/model-overrides.ts",
      )
      .replace(/\n\tconst hermes57PreviousProviderOverride = normalizeOptionalString\(entry\.providerOverride\);/g, "")
      .replace(/\n\tconst hermes57PreviousModelOverride = normalizeOptionalString\(entry\.modelOverride\);/g, "")
      .replace(/\n\tif \(hermes57ApplyModelRuntimeCompat\([^\n]*\)\) updated = true;/g, "");
    if (next.includes("hermes57ApplyModelRuntimeCompat") || next.includes("hermes57-model-compat-v4")) {
      fail(`failed to remove legacy Hermes model override patch from ${file}`);
    }
    return next;
  });
}

function removeLegacyRuntimeClearPatch(dist) {
  const file = findDistFile(dist, /^directive-handling\.persist\.runtime-.*\.js$/, "delete sessionEntry.agentHarnessId", false);
  if (!file) {
    return false;
  }
  return restoreLegacyHermesPatchIfBackupExists(file);
}

function patchAttemptExecution(dist) {
  const file = findDistFile(dist, /^attempt-execution-.*\.js$/, "runAgentAttempt");
  return patchFile(file, (text) => {
    const patched = 'const sessionPinnedAgentHarnessId = isRawModelRun ? "pi" : void 0;';
    if (text.includes(patched)) {
      return text;
    }
    if (!text.includes("resolveSessionPinnedAgentHarnessId")) {
      return text;
    }
    const pattern = /const sessionPinnedAgentHarnessId = isRawModelRun \? "pi" : resolveSessionPinnedAgentHarnessId\(\{\n[\s\S]*?\n\t\}\);/;
    if (!pattern.test(text)) {
      fail(`patch anchor not found in ${file}: sessionPinnedAgentHarnessId`);
    }
    return text.replace(pattern, patched);
  });
}

function patchHarnessSelection(dist) {
  const file = findDistFile(dist, /^selection-.*\.js$/, "selectAgentHarnessDecision");
  return patchFile(file, (text) => {
    let next = text;
    if (next.includes("const policy = pinnedPolicy ?? resolveAgentHarnessPolicy(params);")) {
      next = next.replace(
        "\tconst pinnedPolicy = resolvePinnedAgentHarnessPolicy(params.agentHarnessId);\n\tconst policy = pinnedPolicy ?? resolveAgentHarnessPolicy(params);",
        "\tconst policy = resolveAgentHarnessPolicy(params);",
      );
      next = next
        .replace(/selectedReason: pinnedPolicy \? "pinned" : "forced_pi"/g, 'selectedReason: "forced_pi"')
        .replace(/selectedReason: pinnedPolicy \? "pinned" : "forced_plugin"/g, 'selectedReason: "forced_plugin"');
    }
    if (next.includes("const policy = pinnedPolicy ?? resolveAgentHarnessPolicy(params);")) {
      fail(`failed to remove pinned harness policy from ${file}`);
    }
    return next;
  });
}

const dist = findOpenClawDist();
const changed = [
  removeLegacyHermesModelOverridePatch(dist),
  removeLegacyRuntimeClearPatch(dist),
  patchAttemptExecution(dist),
  patchHarnessSelection(dist),
].some(Boolean);

info(`${changed ? "patched" : "already patched"} OpenClaw 5.7 agent harness stale-pin backport in ${dist}`);

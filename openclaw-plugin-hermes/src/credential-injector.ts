/**
 * openclaw-plugin-hermes — Credential Injector
 *
 * Manages credential scoping for Hermes task dispatch.
 *
 * C0: No credentials — Hermes runs without any external service access
 * C1: Specified — only explicitly listed credential keys are injected
 * C2: All — all known channel/service credentials (requires user confirmation)
 *
 * Credentials are injected as environment variables via docker exec -e.
 * They are NEVER written to disk inside the container.
 * Every injection is audit-logged.
 */

import type { CredentialScope, CredentialEntry, CredentialInjectionResult } from "./types.js";

// ─── Known Credential Registry ──────────────────────────────────────────────

/**
 * Registry of known credential environment variable names organized by service.
 * Used for C2 (all) scope to know what to look for, and for C1 auto-detection.
 */
const CREDENTIAL_REGISTRY: Record<string, string[]> = {
  // LLM Providers
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],

  // Messaging
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN"],
  whatsapp: ["WHATSAPP_AUTH_TOKEN"],

  // Services
  github: ["GITHUB_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"],
  homeassistant: ["HASS_TOKEN", "HASS_URL"],
  email: ["EMAIL_USER", "EMAIL_PASS", "SMTP_HOST", "SMTP_PORT"],

  // Media / AI
  fal: ["FAL_KEY"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],

  // Cloud
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],

  // Volcengine (ARK)
  volcengine: ["ARK_API_KEY", "VOLC_ACCESSKEY", "VOLC_SECRETKEY"],
};

/** Flatten all known credential env var names */
const ALL_CREDENTIAL_KEYS = new Set(Object.values(CREDENTIAL_REGISTRY).flat());

// ─── Injector ───────────────────────────────────────────────────────────────

interface InjectorOptions {
  /**
   * Source of credential values. Defaults to process.env.
   * Can be overridden for testing or to read from OpenClaw's config.
   */
  credentialSource?: Record<string, string | undefined>;
}

/**
 * Inject credentials based on the specified scope.
 *
 * Returns the set of env vars to pass to the Hermes container,
 * along with an audit log of what was injected.
 */
export function injectCredentials(
  scope: CredentialScope,
  options?: InjectorOptions,
): CredentialInjectionResult {
  const source = options?.credentialSource ?? process.env;
  const auditLog: string[] = [];
  const injected: CredentialEntry[] = [];
  const envVars: Record<string, string> = {};
  const timestamp = new Date().toISOString();

  if (scope.mode === "none") {
    auditLog.push(`[${timestamp}] C0: No credentials injected`);
    return { injected, envVars, auditLog };
  }

  if (scope.mode === "specified") {
    const requestedKeys = scope.keys ?? [];
    auditLog.push(`[${timestamp}] C1: Injecting ${requestedKeys.length} specified credential(s)`);

    for (const key of requestedKeys) {
      const value = source[key];
      if (value) {
        envVars[key] = value;
        injected.push({
          key,
          envVar: key,
          value: maskValue(value),
          source: "env",
        });
        auditLog.push(`  ✓ ${key}: injected (${maskValue(value)})`);
      } else {
        auditLog.push(`  ✗ ${key}: not found in environment`);
      }
    }

    return { injected, envVars, auditLog };
  }

  // C2: All credentials
  auditLog.push(`[${timestamp}] C2: Injecting ALL available credentials`);
  auditLog.push(`  ⚠ WARNING: C2 scope — all channel credentials are being shared with Hermes`);

  for (const key of ALL_CREDENTIAL_KEYS) {
    const value = source[key];
    if (value) {
      envVars[key] = value;
      injected.push({
        key,
        envVar: key,
        value: maskValue(value),
        source: "env",
      });
      auditLog.push(`  ✓ ${key}: injected (${maskValue(value)})`);
    }
  }

  auditLog.push(`  Total: ${injected.length} credential(s) injected`);
  return { injected, envVars, auditLog };
}

/**
 * Build docker exec environment flags from injected credentials.
 * Returns an array like ["-e", "KEY=value", "-e", "KEY2=value2"]
 */
export function buildDockerEnvFlags(envVars: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    flags.push("-e", `${key}=${value}`);
  }
  return flags;
}

/**
 * Detect which credential keys a task might need based on the
 * auto-detected keys from the strategy engine.
 */
export function resolveCredentialKeys(
  keys: string[] | undefined,
): string[] {
  if (!keys || keys.length === 0) return [];

  // Deduplicate and validate against known registry
  const resolved = new Set<string>();
  for (const key of keys) {
    if (ALL_CREDENTIAL_KEYS.has(key)) {
      resolved.add(key);
    } else {
      // Try to find by partial match (e.g., "GITHUB" → "GITHUB_TOKEN")
      for (const known of ALL_CREDENTIAL_KEYS) {
        if (known.startsWith(key) || key.startsWith(known.split("_")[0])) {
          resolved.add(known);
        }
      }
    }
  }
  return [...resolved];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Mask a credential value for audit logging.
 * Shows first 4 and last 4 chars, masks the middle.
 */
function maskValue(value: string): string {
  if (value.length <= 12) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

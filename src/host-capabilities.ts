export type HostCapability = {
  name: "lark.docs.search" | "lark.docs.fetch";
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  requiresApproval: boolean;
};

export const HERMES_HOST_CAPABILITIES: HostCapability[] = [
  {
    name: "lark.docs.search",
    description: "Search readable Lark/Feishu documents by keyword.",
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 50 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "lark.docs.fetch",
    description: "Fetch a readable Lark/Feishu document as markdown.",
    readOnly: true,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", minLength: 1 },
      },
      required: ["doc"],
      additionalProperties: false,
    },
  },
];

export function buildHermesHostCapabilityPrompt(capabilities = HERMES_HOST_CAPABILITIES): string {
  const capabilityLines = capabilities
    .map((capability) => `- ${capability.name}: ${capability.description}`)
    .join("\n");

  return [
    "For Lark/Feishu document tasks, do not open Feishu pages in a browser.",
    "Use OpenClaw host capabilities through the CLI instead:",
    "",
    capabilityLines,
    "",
    'Examples:',
    `- openclaw-host-tool lark.docs.search '{"query":"Hermes Agent OpenClaw"}'`,
    `- openclaw-host-tool lark.docs.fetch '{"doc":"https://bytedance.larkoffice.com/docx/LMWBdoa5QozsMYxXfhtc0dXsnJc"}'`,
    "",
    "Search queries must be 50 characters or fewer.",
    "If openclaw-host-tool is unavailable or returns permission_denied, explain that this Hermes runtime currently lacks the required OpenClaw host capability.",
  ].join("\n");
}

export type HostCapability = {
  name: "lark.docs.search" | "lark.docs.fetch" | "lark.docs.create" | "lark.docs.update";
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
  {
    name: "lark.docs.create",
    description: "Create a Lark/Feishu document from markdown.",
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        markdown: { type: "string", minLength: 1 },
        folderToken: { type: "string" },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "lark.docs.update",
    description: "Update a Lark/Feishu document with markdown using an explicit update mode.",
    readOnly: false,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["append", "overwrite", "replace_range", "replace_all", "insert_before", "insert_after", "delete_range"] },
        markdown: { type: "string" },
        selectionWithEllipsis: { type: "string" },
        selectionByTitle: { type: "string" },
        newTitle: { type: "string" },
      },
      required: ["doc", "mode"],
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
    `- openclaw-host-tool lark.docs.create '{"title":"Summary","markdown":"## Summary\\n\\n..."}'`,
    `- openclaw-host-tool lark.docs.update '{"doc":"https://bytedance.larkoffice.com/docx/...","mode":"append","markdown":"## Update\\n\\n..."}'`,
    "",
    "Search queries must be 50 characters or fewer.",
    "Use create/update only when the user asks to output, create, append, or update a Feishu document.",
    "If openclaw-host-tool is unavailable or returns permission_denied, explain that this Hermes runtime currently lacks the required OpenClaw host capability.",
  ].join("\n");
}

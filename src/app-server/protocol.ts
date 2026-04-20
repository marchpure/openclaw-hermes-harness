export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type RpcRequest = {
  id?: number | string;
  method: string;
  params?: JsonValue;
};

export type RpcResponse = {
  id: number | string;
  result?: JsonValue;
  error?: {
    code?: number;
    message: string;
    data?: JsonValue;
  };
};

export type RpcMessage = RpcRequest | RpcResponse;

export type HermesDynamicToolSpec = {
  name: string;
  description: string;
  inputSchema: JsonValue;
};

export type HermesUserInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export type HermesThreadStartParams = {
  cwd: string;
  model?: string | null;
  dynamicTools?: HermesDynamicToolSpec[] | null;
  systemPrompt?: string | null;
};

export type HermesThreadStartResponse = {
  thread: {
    id: string;
    cwd: string;
  };
};

export type HermesTurnStartParams = {
  threadId: string;
  input: HermesUserInput[];
};

export type HermesTurnStartResponse = {
  turn: {
    id: string;
    status: "completed" | "failed" | "interrupted";
    error?: { message?: string } | null;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type HermesServerNotification = {
  method: string;
  params?: JsonValue;
};

export type HermesDynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments?: JsonValue;
};

export type HermesDynamicToolCallResponse = {
  contentItems: HermesDynamicToolCallOutputContentItem[];
  success: boolean;
};

export type HermesDynamicToolCallOutputContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return "id" in message && !("method" in message);
}

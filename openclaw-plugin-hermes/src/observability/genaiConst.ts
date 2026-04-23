/**
 * GenAI Span Attributes
 * Reference: https://www.volcengine.com/docs/86845/1963483?lang=zh
 */

// 模型与请求元数据
export const GEN_AI_SYSTEM = 'gen_ai.system';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_REQUEST_TYPE = 'gen_ai.request.type';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p';

// 输入输出内容
export const GEN_AI_RESPONSE_FINISH_REASON = 'gen_ai.response.finish_reason';
export const GEN_AI_RESPONSE_STOP_REASON = 'gen_ai.response.stop_reason';

// Token 使用统计
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens';
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = 'gen_ai.usage.cache_creation_input_tokens';
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read_input_tokens';
export const GEN_AI_TOKEN_TYPE = 'gen_ai.token.type';

// 流式处理与性能指标
export const GEN_AI_IS_STREAMING = 'gen_ai.is_streaming';
export const GEN_AI_STREAMING_TIME_TO_FIRST_TOKEN = 'gen_ai.chat_completions.streaming_time_to_first_token';
export const GEN_AI_STREAMING_TIME_PER_OUTPUT_TOKEN = 'gen_ai.chat_completions.streaming_time_per_output_token';

// 用户与会话信息
export const GEN_AI_USER_ID = 'gen_ai.user.id';
export const GEN_AI_SESSION_ID = 'gen_ai.session.id';


export const GEN_AI_SPAN_KIND = 'gen_ai.span.kind';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';

export enum GenAiSpanKind {
    LLM = 'llm',
    LLMLoop = 'llm_loop',
    Agent = 'agent',
    Tool = 'tool',
    SubAgent = 'subagent',
    Root = 'root',
}

export const GEN_AI_INPUT = 'gen_ai.input';
export const GEN_AI_OUTPUT = 'gen_ai.output';

// Helper functions for dynamic keys (输入输出内容中的动态索引)
export const getGenAiPromptRole = (index: number) => `gen_ai.prompt.${index}.role`;
export const getGenAiPromptContent = (index: number) => `gen_ai.prompt.${index}.content`;
export const getGenAiCompletionRole = (index: number) => `gen_ai.completion.${index}.role`;
export const getGenAiCompletionContent = (index: number) => `gen_ai.completion.${index}.content`;


export const _GEN_AI_DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]

export const _GEN_AI_CLIENT_TOKEN_USAGE_BUCKETS = [
    1,
    4,
    16,
    64,
    256,
    1024,
    4096,
    16384,
    65536,
    262144,
    1048576,
    4194304,
    16777216,
    67108864,
]

export const _GEN_AI_CLIENT_RESPONSE_SIZE_BUCKETS = [
    0,        // 空响应，le=0 的计数就是空响应数量
    1,
    4,
    16,
    64,
    256,
    1024,     // 1 KB
    4096,     // 4 KB
    16384,    // 16 KB
    65536,    // 64 KB
    262144,   // 256 KB
    1048576,  // 1 MB
    4194304,  // 4 MB
    16777216, // 16 MB
]
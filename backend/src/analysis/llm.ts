import type { TokenUsage } from "./types.js";

/** 一次对话请求：system 稳定（可命中提示词缓存），user 承载数据。 */
export type ChatRequest = { system: string; user: string };

/** 一次对话的结果：正文 + 可选 token 用量。 */
export type ChatResult = {
  content: string;
  usage?: TokenUsage;
};

/** 对话函数签名 —— 抽象成类型，便于测试注入 fake LLM（主 seam）。 */
export type ChatFn = (req: ChatRequest) => Promise<ChatResult>;

/** LLM 调用失败（网络/鉴权/额度等）。 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type DeepSeekConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 采样温度：分析任务取低值以减少随机性 */
  temperature?: number;
};

const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-chat";

/**
 * 创建 DeepSeek 对话函数（T4 决策：deepseek-chat + JSON 输出模式）。
 *
 * key 只从服务端环境变量读取，永不进入前端（规格合规要求）。
 */
export function createDeepSeekChat(config: DeepSeekConfig): ChatFn {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  return async ({ system, user }) => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // JSON 输出模式：要求提示词中出现 "JSON" 字样（我们的 schema 段已满足）
          response_format: { type: "json_object" },
          temperature: config.temperature ?? 0.3,
          stream: false,
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 90_000),
      });
    } catch (err) {
      throw new LlmError(`LLM 请求失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LlmError(
        `LLM 返回 HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ""}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    const usage = data.usage;
    return {
      content,
      // 用量缺失时保持 undefined，不伪造 0（前端据此决定是否展示）
      usage:
        usage && typeof usage.total_tokens === "number"
          ? {
              promptTokens: usage.prompt_tokens ?? 0,
              completionTokens: usage.completion_tokens ?? 0,
              totalTokens: usage.total_tokens,
              ...(typeof usage.prompt_cache_hit_tokens === "number"
                ? { cachedTokens: usage.prompt_cache_hit_tokens }
                : {}),
            }
          : undefined,
    };
  };
}

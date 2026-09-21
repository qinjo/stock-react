import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import { dataRoutes } from "./routes/data.js";
import { analyzeRoutes } from "./routes/analyze.js";
import { DEFAULT_MODEL, createDeepSeekChat, type ChatFn } from "./analysis/llm.js";
import type { CachedAnalysis } from "./analysis/index.js";
import { PromptCache } from "./cache.js";

export type BuildAppOptions = {
  /** 测试注入 fake LLM；生产从此处之外的默认行为创建 */
  chat?: ChatFn;
  model?: string;
  /** 显式传入 API key（默认读 DEEPSEEK_API_KEY） */
  apiKey?: string;
  /** 分析缓存 TTL（毫秒）；默认 10 分钟，可用 ANALYSIS_CACHE_TTL_MS 覆盖 */
  cacheTtlMs?: number;
};

/**
 * 构建应用实例（不含监听）。
 * 独立成函数是为了测试：测试用 `app.inject()` 发请求，不占端口、不触网。
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // API key 只存在于服务端；未配置时 /api/analyze 返回明确的配置错误
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const chat: ChatFn | null =
    options.chat ?? (apiKey ? createDeepSeekChat({ apiKey, model }) : null);

  app.get("/api/health", async () => {
    return {
      status: "ok",
      service: "stock-backend",
      time: new Date().toISOString(),
      analysisReady: chat !== null,
    };
  });

  const cacheTtlMs =
    options.cacheTtlMs ?? Number(process.env.ANALYSIS_CACHE_TTL_MS ?? 10 * 60 * 1000);
  const cache = new PromptCache<CachedAnalysis>(
    Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : 10 * 60 * 1000,
  );

  app.register(dataRoutes);
  app.register(async (instance) => analyzeRoutes(instance, { chat, model, cache }));

  // 统一错误形状：{ status, code, message }
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.httpStatus).send(err.toBody());
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.status(status).send({
      status: "error",
      code: "SOURCE_UNAVAILABLE",
      message: status >= 500 ? "服务暂时不可用" : err.message,
    });
  });

  return app;
}

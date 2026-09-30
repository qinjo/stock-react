import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import { dataRoutes } from "./routes/data.js";
import { analyzeRoutes } from "./routes/analyze.js";
import { fundamentalsRoutes } from "./routes/fundamentals.js";
import { screenerRoutes, type ScreenerRouteDeps } from "./routes/screener.js";
import type { ScreenResponse } from "./screener/response.js";
import { runIncrement } from "./market/increment.js";
import { DEFAULT_MODEL, createDeepSeekChat, type ChatFn } from "./analysis/llm.js";
import type { CachedAnalysis } from "./analysis/index.js";
import { PromptCache } from "./cache.js";
import { rateLimitFromEnv, registerRateLimit, type RateLimitOptions } from "./rate-limit.js";

export type BuildAppOptions = {
  /** 测试注入 fake LLM；生产从此处之外的默认行为创建 */
  chat?: ChatFn;
  model?: string;
  /** 显式传入 API key（默认读 DEEPSEEK_API_KEY） */
  apiKey?: string;
  /** 分析缓存 TTL（毫秒）；默认 10 分钟，可用 ANALYSIS_CACHE_TTL_MS 覆盖 */
  cacheTtlMs?: number;
  /** 限流配置；默认读环境变量（默认关闭） */
  rateLimit?: RateLimitOptions;
  /** 筛选路由依赖：测试注入临时日K库与固定时钟 */
  screener?: ScreenerRouteDeps;
  /** 筛选结果缓存 TTL（毫秒）；默认 6 小时，可用 SCREEN_CACHE_TTL_MS 覆盖 */
  screenCacheTtlMs?: number;
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

  registerRateLimit(app, options.rateLimit ?? rateLimitFromEnv());

  // 筛选结果缓存：键含数据指纹，因此"数据一变就失效"；TTL 只是兜底的上界。
  // 全市场遍历约 5 秒且每次重读七百多万行，同一天同一组参数没有理由再算一遍。
  const screenCacheTtlMs =
    options.screenCacheTtlMs ?? Number(process.env.SCREEN_CACHE_TTL_MS ?? 6 * 60 * 60 * 1000);
  const screenCache = new PromptCache<{ response: ScreenResponse }>(
    Number.isFinite(screenCacheTtlMs) && screenCacheTtlMs > 0 ? screenCacheTtlMs : 6 * 60 * 60 * 1000,
    200,
  );

  app.register(dataRoutes);
  app.register(fundamentalsRoutes);
  app.register(async (instance) => analyzeRoutes(instance, { chat, model, cache }));
  app.register(async (instance) =>
    screenerRoutes(instance, {
      // 生产走真实增量；测试必须显式注入假实现（类型上也是必填）
      runIncrement,
      cache: screenCache,
      // 未配置密钥时传 null：复核会自动降级，而不是让整个筛选失败
      chat,
      ...(options.screener ?? {}),
    }),
  );

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

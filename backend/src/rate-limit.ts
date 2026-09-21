import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 按 IP 的固定窗口限流（公开部署时可启用）。
 *
 * 动机：本项目的免费数据源（东财有 IP 级反爬）与 LLM 调用都按量付费/限流，
 * 公开部署时若无限制，一个脚本就能把额度耗尽或触发数据源封禁。
 *
 * 默认关闭（ENABLED=false），本地开发不受影响；启动时用
 * RATE_LIMIT_ENABLED=true 打开，并可用 MAX / WINDOW_MS 调整窗口。
 */

export type RateLimitOptions = {
  enabled: boolean;
  /** 每个窗口内允许的请求数 */
  max: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  enabled: false,
  max: 30,
  windowMs: 60_000,
};

/** 从环境变量读取限流配置（带校验与回退）。 */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitOptions {
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: env.RATE_LIMIT_ENABLED === "true",
    max: num(env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT.max),
    windowMs: num(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT.windowMs),
  };
}

type Bucket = { count: number; resetAt: number };

/**
 * 注册限流钩子。返回受影响的请求判定函数便于测试。
 * @param now 可注入时钟（测试用）
 */
export function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitOptions,
  now: () => number = Date.now,
): void {
  if (!options.enabled) return;

  const buckets = new Map<string, Bucket>();

  /** 惰性清理过期桶，避免长期运行后内存无界增长。 */
  function sweep(currentTime: number): void {
    if (buckets.size < 1000) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= currentTime) buckets.delete(key);
    }
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const currentTime = now();
    sweep(currentTime);

    const key = request.ip || "unknown";
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= currentTime) {
      buckets.set(key, { count: 1, resetAt: currentTime + options.windowMs });
      return;
    }

    if (bucket.count >= options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      await reply
        .status(429)
        .header("Retry-After", String(retryAfterSec))
        .send({
          status: "error",
          code: "RATE_LIMITED",
          message: `请求过于频繁，请在 ${retryAfterSec} 秒后重试`,
        });
      return;
    }

    bucket.count++;
  });
}

import type { FastifyInstance } from "fastify";
import { fetchKline, fetchQuote } from "../datasource.js";
import { fetchSuggest } from "../tencent.js";
import { computeIndicators, InsufficientDataError } from "../indicators.js";
import { ApiError } from "../errors.js";

/**
 * 行情与指标路由：/api/search、/api/quote、/api/kline、/api/indicators。
 *
 * 错误契约：输入问题→INVALID_INPUT(400)；数据不足→INSUFFICIENT_DATA(400)；
 * 外部源故障→SOURCE_UNAVAILABLE(502)。内部错误细节不外泄给前端。
 */
export async function dataRoutes(app: FastifyInstance): Promise<void> {
  /** 统一映射数据层异常；`无法识别` 前缀来自适配器的输入校验。 */
  async function guardSource<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.message.startsWith("无法识别")) {
        throw new ApiError("INVALID_INPUT", err.message, 400);
      }
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", `${label}暂时不可用`, 502);
    }
  }

  function requireCode(raw: string | undefined): string {
    const code = (raw ?? "").trim();
    if (!code) throw new ApiError("INVALID_INPUT", "缺少 code 参数", 400);
    return code;
  }

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { candidates: [] };
    return { candidates: await guardSource("搜索服务", () => fetchSuggest(q)) };
  });

  app.get<{ Querystring: { code?: string } }>("/api/quote", async (req) => {
    const code = requireCode(req.query.code);
    return { quote: await guardSource("行情数据源", () => fetchQuote(code)) };
  });

  app.get<{ Querystring: { code?: string; limit?: string } }>("/api/kline", async (req) => {
    const code = requireCode(req.query.code);
    const rawLimit = Number(req.query.limit ?? 60);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 60, 1), 500);
    return { klines: await guardSource("K线数据源", () => fetchKline(code, limit)) };
  });

  app.get<{ Querystring: { code?: string; limit?: string } }>(
    "/api/indicators",
    async (req) => {
      const code = requireCode(req.query.code);
      // 指标需要长历史：SMA200 要求 200 根，故默认取 250 根
      const rawLimit = Number(req.query.limit ?? 250);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 250, 1), 500);

      const klines = await guardSource("K线数据源", () => fetchKline(code, limit));
      try {
        return { indicators: computeIndicators(klines) };
      } catch (err) {
        if (err instanceof InsufficientDataError) {
          throw new ApiError("INSUFFICIENT_DATA", err.message, 400);
        }
        app.log.error(err);
        throw new ApiError("SOURCE_UNAVAILABLE", "指标计算失败", 502);
      }
    },
  );
}

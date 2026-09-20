import type { FastifyInstance } from "fastify";
import { fetchKline, fetchQuote } from "../datasource.js";
import { fetchSuggest } from "../tencent.js";
import { ApiError } from "../errors.js";

/**
 * 行情数据路由：/api/search、/api/quote、/api/kline。
 * 外部数据源异常统一映射为 SOURCE_UNAVAILABLE，避免把内部错误细节泄露给前端。
 */
export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { candidates: [] };
    try {
      return { candidates: await fetchSuggest(q) };
    } catch (err) {
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", "搜索服务暂时不可用", 502);
    }
  });

  app.get<{ Querystring: { code?: string } }>("/api/quote", async (req) => {
    const code = (req.query.code ?? "").trim();
    if (!code) throw new ApiError("INVALID_INPUT", "缺少 code 参数", 400);
    try {
      return { quote: await fetchQuote(code) };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.message.startsWith("无法识别")) {
        throw new ApiError("INVALID_INPUT", err.message, 400);
      }
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", "行情数据源暂时不可用", 502);
    }
  });

  app.get<{ Querystring: { code?: string; limit?: string } }>("/api/kline", async (req) => {
    const code = (req.query.code ?? "").trim();
    if (!code) throw new ApiError("INVALID_INPUT", "缺少 code 参数", 400);
    const rawLimit = Number(req.query.limit ?? 60);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 60, 1), 500);
    try {
      return { klines: await fetchKline(code, limit) };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof Error && err.message.startsWith("无法识别")) {
        throw new ApiError("INVALID_INPUT", err.message, 400);
      }
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", "K线数据源暂时不可用", 502);
    }
  });
}

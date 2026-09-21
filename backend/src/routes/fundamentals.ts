import type { FastifyInstance } from "fastify";
import { fetchQuote } from "../datasource.js";
import { fetchFundamentals } from "../fundamentals.js";
import { ApiError } from "../errors.js";

/**
 * 基本面路由：/api/fundamentals?code=
 *
 * 与 /api/analyze 相同的取数逻辑，但独立暴露——前端在选中股票后即可展示
 * 估值分位与财务趋势，不必等待（也不消耗）LLM 调用。
 */
export async function fundamentalsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { code?: string } }>("/api/fundamentals", async (req) => {
    const code = (req.query.code ?? "").trim();
    if (!code) throw new ApiError("INVALID_INPUT", "缺少 code 参数", 400);

    let currentPe: number | null = null;
    let currentPb: number | null = null;
    try {
      const quote = await fetchQuote(code);
      currentPe = quote.pe;
      currentPb = quote.pb;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("无法识别")) {
        throw new ApiError("INVALID_INPUT", err.message, 400);
      }
      // 行情失败仍可尝试基本面（估值分位依赖当前 PE/PB，会退化为 null）
      app.log.warn(err);
    }

    try {
      const fundamentals = await fetchFundamentals(code, currentPe, currentPb);
      return { fundamentals };
    } catch (err) {
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", "基本面数据源暂时不可用", 502);
    }
  });
}

import type { FastifyInstance } from "fastify";
import { fetchKline, fetchQuote } from "../datasource.js";
import { computeIndicators, InsufficientDataError } from "../indicators.js";
import { runAnalysis } from "../analysis/index.js";
import type { ChatFn } from "../analysis/llm.js";
import type { AnalysisInput } from "../analysis/types.js";
import { ApiError } from "../errors.js";

/** 喂给提示词的日 K 根数（规格 Q13：指标为主 + 60 根截尾日 K）。 */
export const PROMPT_KLINES = 60;
/** 计算指标所需日 K 根数（SMA200 要求）。 */
export const INDICATOR_KLINES = 250;

export type AnalyzeDeps = {
  /** 对话函数；未配置（缺 API key）时为 null */
  chat: ChatFn | null;
  model: string;
};

/** 组装分析输入：行情+指标+截尾 K 线，冻结为确定性域对象。 */
export async function buildAnalysisInput(code: string): Promise<AnalysisInput> {
  const [quote, klines] = await Promise.all([
    fetchQuote(code),
    fetchKline(code, INDICATOR_KLINES),
  ]);

  const indicators = computeIndicators(klines); // 数据不足时抛 InsufficientDataError
  const dataDate = klines[klines.length - 1]!.date;

  return {
    code: quote.code || code,
    name: quote.name,
    dataDate,
    quote: {
      price: quote.price,
      changePercent: quote.changePercent,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      prevClose: quote.prevClose,
      marketCap: quote.marketCap,
      pe: quote.pe,
      pb: quote.pb,
      turnoverRate: quote.turnoverRate,
    },
    indicators: indicators as unknown as Record<string, unknown>,
    klines: klines.slice(-PROMPT_KLINES).map((k) => ({
      date: k.date,
      open: k.open,
      close: k.close,
      high: k.high,
      low: k.low,
      volume: k.volume,
    })),
  };
}

/**
 * 分析路由：/api/analyze。
 * 缓存与前端属于 T5；此端点先提供可 curl 的完整编排能力。
 */
export async function analyzeRoutes(app: FastifyInstance, deps: AnalyzeDeps): Promise<void> {
  app.get<{ Querystring: { code?: string } }>("/api/analyze", async (req) => {
    const code = (req.query.code ?? "").trim();
    if (!code) throw new ApiError("INVALID_INPUT", "缺少 code 参数", 400);

    if (!deps.chat) {
      throw new ApiError(
        "ANALYSIS_FAILED",
        "服务端未配置 DEEPSEEK_API_KEY，无法进行分析",
        503,
      );
    }

    let input: AnalysisInput;
    try {
      input = await buildAnalysisInput(code);
    } catch (err) {
      if (err instanceof InsufficientDataError) {
        throw new ApiError("INSUFFICIENT_DATA", err.message, 400);
      }
      if (err instanceof Error && err.message.startsWith("无法识别")) {
        throw new ApiError("INVALID_INPUT", err.message, 400);
      }
      app.log.error(err);
      throw new ApiError("SOURCE_UNAVAILABLE", "行情数据源暂时不可用", 502);
    }

    const outcome = await runAnalysis(input, { chat: deps.chat, model: deps.model });

    if (outcome.status === "abstained") {
      // 数据不足与调用失败要可区分（abstain 契约）
      throw new ApiError("ANALYSIS_FAILED", outcome.detail, 502);
    }

    return { ...outcome, input: { code: input.code, name: input.name, dataDate: input.dataDate } };
  });
}

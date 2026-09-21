import { useState } from "react";
import { getAnalysis } from "../api";
import { ApiError, type AnalyzeResponse, type ApiErrorCode } from "../types";
import RatingCard from "./RatingCard";
import AnalysisReport from "./AnalysisReport";

type Props = {
  code: string;
  name: string;
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; data: AnalyzeResponse }
  | { kind: "error"; code: ApiErrorCode; message: string };

/** 错误码 → 用户可读的标题与处置提示（区分「数据不足」与「失败」）。 */
const ERROR_COPY: Partial<Record<ApiErrorCode, { title: string; hint: string }>> = {
  INSUFFICIENT_DATA: {
    title: "数据不足，无法分析",
    hint: "该股票历史数据过短（新股或长期停牌），按约定不做强行判断。",
  },
  ANALYSIS_FAILED: {
    title: "分析失败",
    hint: "模型调用或输出解析失败，可稍后重试；这不代表看空。",
  },
  SOURCE_UNAVAILABLE: {
    title: "数据源暂时不可用",
    hint: "行情数据源限流或断连，请稍后重试。",
  },
  INVALID_INPUT: { title: "股票代码无效", hint: "请检查代码后重试。" },
  RATE_LIMITED: { title: "请求过于频繁", hint: "服务端已限流，请稍等片刻再试。" },
};

/** 分析面板：触发分析并渲染信号卡 + 五节报告，带三态异常处理。 */
export default function AnalysisPanel({ code, name }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      const data = await getAnalysis(code);
      setState({ kind: "ok", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code, message: err.message });
      } else {
        setState({
          kind: "error",
          code: "ANALYSIS_FAILED",
          message: err instanceof Error ? err.message : "分析失败",
        });
      }
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-medium text-slate-700">AI 分析</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            由大模型基于上方行情与派生指标生成，耗时约 10–60 秒
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state.kind === "loading"}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {state.kind === "loading" ? "分析中…" : state.kind === "idle" ? "开始 AI 分析" : "重新分析"}
        </button>
      </div>

      {state.kind === "loading" && (
        <p className="text-sm text-slate-500" role="status">
          正在调用模型分析 {name}…
        </p>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
        >
          <p className="font-medium">{ERROR_COPY[state.code]?.title ?? "分析失败"}</p>
          <p className="mt-1">{state.message}</p>
          {ERROR_COPY[state.code]?.hint && (
            <p className="mt-1 text-xs">{ERROR_COPY[state.code]!.hint}</p>
          )}
        </div>
      )}

      {state.kind === "ok" && (
        <>
          <RatingCard
            analysis={state.data.analysis}
            model={state.data.model}
            analyzedAt={state.data.analyzedAt}
            fromCache={state.data.fromCache}
            usage={state.data.usage}
          />
          <AnalysisReport analysis={state.data.analysis} />
          <p className="text-xs text-slate-400">数据截至：{state.data.input.dataDate}</p>
        </>
      )}
    </section>
  );
}

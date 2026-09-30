import { useState } from "react";
import { getAnalysis } from "../../api";
import type { AnalyzeResponse } from "../../types";

/**
 * 按需触发的短线视角深度分析。
 *
 * **不自动对全部候选调用**：一次筛选可能出十只票，自动跑就是十次大模型调用，
 * 既慢又贵。这里只在用户点按钮时才请求一只。
 */
export function DeepAnalysis({ code, name }: { code: string; name: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; data: AnalyzeResponse }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ok", data: await getAnalysis(code, "short") });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "分析失败" });
    }
  }

  const report = state.kind === "ok" ? state.data.analysis : null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state.kind === "loading"}
        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {state.kind === "loading" ? "分析中…" : "深度分析（短线视角）"}
      </button>

      {state.kind === "error" && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {state.message}
        </p>
      )}

      {report && (
        <div className="mt-2 space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <p className="text-slate-500">
            {name} · 短线视角 · 置信度 {report.confidence}
          </p>
          <p className="text-slate-700">{report.reasoning}</p>
          <p className="text-slate-600">
            <span className="text-slate-400">①MA100 位置：</span>
            {report.sections.snapshot}
          </p>
          <p className="text-slate-600">
            <span className="text-slate-400">②结构形态：</span>
            {report.sections.fundamentals}
          </p>
          <p className="text-slate-600">
            <span className="text-slate-400">③离场条件：</span>
            {report.sections.technicals}
          </p>
          <ul className="space-y-0.5 text-slate-600">
            {report.sections.risks.map((item) => (
              <li key={item}>
                <span className="text-slate-400">④</span>
                {item}
              </li>
            ))}
          </ul>
          {report.dataLimits.length > 0 && (
            <p className="text-[11px] text-amber-700">数据边界：{report.dataLimits.join("；")}</p>
          )}
        </div>
      )}
    </div>
  );
}

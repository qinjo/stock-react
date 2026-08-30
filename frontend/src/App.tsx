import { useEffect, useState } from "react";

type Health = { status: string; service: string; time: string };

/**
 * T1 入口页：股票查询入口（补全待 T2）+ 后端连通状态显示。
 * 后端状态通过 Vite 代理的 /api/health 获取，验证前后端链路打通。
 */
export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Health) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setBackendError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">A股智能分析</h1>
        <p className="mt-1 text-sm text-slate-500">
          输入股票代码或名称，获取行情与 AI 分析（开发中）
        </p>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-8">
        {/* 查询入口：补全交互在 T2 实现 */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <label htmlFor="stock-input" className="block text-sm font-medium text-slate-700">
            股票代码 / 名称
          </label>
          <input
            id="stock-input"
            type="text"
            placeholder="如 600519 或 茅台"
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <p className="mt-2 text-xs text-slate-400">搜索与补全功能将在下一迭代提供</p>
        </div>

        {/* 后端连通状态 */}
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-medium text-slate-700">后端连通状态</h2>
          {backendError ? (
            <p className="mt-2 text-sm text-red-600" role="alert">
              无法连接后端：{backendError}
            </p>
          ) : health ? (
            <p className="mt-2 text-sm text-emerald-600">
              {health.service} · {health.status} · {new Date(health.time).toLocaleString("zh-CN")}
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-400">检测中…</p>
          )}
        </div>
      </main>
    </div>
  );
}
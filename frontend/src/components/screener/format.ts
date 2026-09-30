/**
 * 界面共用的数字/日期格式化。
 *
 * 单独成文件是因为它们被面板、候选卡片与结果视图同时使用——
 * 留在一个 700 行的组件文件里，任何一处改格式都得先读懂整份文件。
 */

export const pct = (v: number | null, digits = 1): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

export const money = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v / 1e8).toFixed(2)}亿`;

export const formatDateKey = (key: number | null): string => {
  if (key === null) return "—";
  const text = String(key);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
};

export const price = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : v.toFixed(2);

export function signClass(v: number | null): string {
  if (v === null || v === undefined || v === 0) return "text-slate-700";
  return v > 0 ? "text-red-600" : "text-emerald-600";
}

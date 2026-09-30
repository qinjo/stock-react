import type { MarketGate } from "../../types";


const GATE_STYLE: Record<string, { box: string; label: string; position: string }> = {
  offense: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", label: "进攻", position: "满仓" },
  defense: { box: "border-amber-200 bg-amber-50 text-amber-900", label: "防守", position: "半仓" },
  empty: { box: "border-red-200 bg-red-50 text-red-800", label: "空仓", position: "空仓" },
};

export function MarketGateBanner({ gate, ignored }: { gate: MarketGate; ignored: boolean }) {
  const style = GATE_STYLE[gate.state] ?? GATE_STYLE.defense!;
  const positionPct = `${Math.round(gate.positionAdvice * 100)}%`;

  return (
    <div className={`rounded-lg border p-3 text-sm ${style.box}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">大盘门：{style.label}档</p>
        <p className="text-xs">
          今日建议总仓位
          <span className="ml-1 font-medium">{positionPct}</span>
          <span className="ml-1 opacity-70">（{style.position}）</span>
        </p>
      </div>
      <p className="mt-1 text-xs opacity-90">{gate.reason}</p>
      {ignored && gate.state === "empty" && (
        <p className="mt-1 text-xs font-medium">
          ⚠ 你已忽略大盘门：以下候选是在违反书的择时前提（跌破 MA100 应停手）的情况下给出的。
        </p>
      )}
    </div>
  );
}

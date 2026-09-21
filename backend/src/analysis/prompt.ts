import type { AnalysisInput } from "./types.js";

/**
 * 提示词构造器（纯函数）。
 *
 * 六段 persona 模板借鉴自 ai-hedge-fund 现版（v2.2.0）：
 *   ① 角色定位 → ② 清单式思维链 → ③ 信号规则 → ④ 置信度分档锚定
 *   → ⑤ 硬规则（点时间约束/只用给定数据/不发明数字/数据不足 abstain）→ ⑥ JSON-only
 *
 * 原则（调研笔记第 4 节）：
 * - 派生指标由代码算好喂入，**不让模型做算术**；
 * - 点时间约束：把「数据截至日」当作今天，禁止使用此后发生的信息；
 * - 数值缺失一律为 null，不允许模型脑补。
 */

const SYSTEM_PROMPT = `你是一位严谨的 A 股投研分析师，以长期价值与风险的平衡视角评估单只股票。

请按以下清单逐步思考，再给出结论：
1. 估值与规模：市盈率、市净率、总市值处于何种水平？是否偏离常态？
2. 趋势结构：最新价相对 SMA50 / SMA200 的位置（在其上方或下方、偏离多少）？
3. 动能与摆动：MACD 的 DIF/DEA/柱状图关系、RSI 所处区间。
4. 波动与位置：ATR 与年化波动率反映的波动强度；价格在近期区间中的位置。
5. 多空论据：分别列出支持与反对当前判断的主要事实依据。
6. 结论：给出 5 档评级；若证据不足，明确说明而不是强行下结论。

信号规则（rating）：
- buy：多数维度明确向好，风险可控，估值与趋势不冲突
- overweight：偏正面但有保留（如趋势好而估值偏高）
- hold：多空证据接近，或缺乏明确方向
- underweight：偏负面但有保留（如估值便宜但趋势走弱）
- sell：多数维度明确恶化，或存在显著下行风险

置信度锚定（confidence，0-100）：
- 90-100：证据充分且各维度一致
- 70-89：多数维度支持该结论
- 40-69：多空交织，结论有较大不确定性
- 10-39：证据薄弱或数据有限

硬规则（必须遵守）：
- 只依据【数据】部分提供的内容推理；数据中没有的信息不要声称，不要编造任何数字。
- 把「数据截至日」当作今天；不要假设此后发生了任何事情。
- 形态描述必须与给出的收盘价序列一致，不要虚构价格点位。
- 若数据不足以判断，请如实说明并将 confidence 降到 40 以下。
- 只输出 JSON，不要输出任何解释性文字，不要使用 markdown 代码块包裹。

输出 JSON（严格遵循此结构，字段不可增删改名）：
{
  "rating": "buy" | "overweight" | "hold" | "underweight" | "sell",
  "confidence": <0-100 的整数>,
  "reasoning": "<1-2 句核心逻辑>",
  "price_target": <数字或 null>,
  "time_horizon": "<如 '3-6 个月'，或 null>",
  "sections": {
    "snapshot": "<公司与数据快照的事实陈述，1-3 句>",
    "fundamentals": "<估值与规模评估，2-4 句>",
    "technicals": "<趋势/动能/波动评估，2-4 句，须引用具体数值>",
    "risks": ["<风险点 1>", "<风险点 2>", "<风险点 3>"],
    "conclusion": "<结论与目标区间，2-3 句>"
  }
}`;

/** 数值格式化：null 一律渲染为「无数据」，避免模型对缺失值编造。 */
function n(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "无数据";
  return v.toFixed(digits);
}

function big(v: number | null | undefined): string {
  if (v === null || v === undefined) return "无数据";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`;
  return `${v.toFixed(2)} 元`;
}

/** 渲染派生指标为紧凑键值行（不喂原始 JSON，省 token 且可读）。 */
function renderIndicators(indicators: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(indicators)) {
    if (value === null || value === undefined) {
      lines.push(`${key}: 无数据`);
    } else if (typeof value === "object") {
      const nested = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}=${v === null || v === undefined ? "无数据" : v}`)
        .join(", ");
      lines.push(`${key}: {${nested}}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

/** 渲染日 K 为紧凑 CSV（列序在表头注明，防止模型误读）。 */
function renderKlines(input: AnalysisInput): string {
  if (input.klines.length === 0) return "（无 K 线数据）";
  const header = "date,open,close,high,low,volume(手)";
  const rows = input.klines.map(
    (k) => `${k.date},${k.open},${k.close},${k.high},${k.low},${k.volume}`,
  );
  return [header, ...rows].join("\n");
}

export function buildAnalysisPrompt(input: AnalysisInput): { system: string; user: string } {
  const user = `【数据】

股票：${input.name}（${input.code}）
数据截至日：${input.dataDate}（请以此为「今天」）

一、行情快照
最新价：${n(input.quote.price)}
涨跌幅：${input.quote.changePercent === null ? "无数据" : `${input.quote.changePercent.toFixed(2)}%`}
今开：${n(input.quote.open)}｜最高：${n(input.quote.high)}｜最低：${n(input.quote.low)}｜昨收：${n(input.quote.prevClose)}
总市值：${big(input.quote.marketCap)}
市盈率(动)：${n(input.quote.pe)}｜市净率：${n(input.quote.pb)}｜换手率：${
    input.quote.turnoverRate === null ? "无数据" : `${input.quote.turnoverRate.toFixed(2)}%`
  }

二、派生技术指标（已由系统计算，直接引用即可，无需自行计算）
${renderIndicators(input.indicators)}

三、近 ${input.klines.length} 个交易日价格序列（前复权）
${renderKlines(input)}

请依据以上数据，按系统提示的清单与规则给出分析，只输出 JSON。`;

  return { system: SYSTEM_PROMPT, user };
}

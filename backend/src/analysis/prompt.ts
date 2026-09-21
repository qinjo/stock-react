import type { AnalysisInput } from "./types.js";
import type { SignalTally } from "../derived.js";

/**
 * 提示词构造器（纯函数）。
 *
 * 六段 persona 模板源自 ai-hedge-fund 现版；本轮按调研笔记（`_research/提示词优化调研笔记.md`）
 * 做了针对性强化，逐条对应曾经的失败模式：
 * - 基本面空泛 → 给出**字数下限 + 追问式模板**（FinRobot `major_takeaways_agent.py:8-20`）
 * - 模型拿通用财经常识填空 → 显式【数据边界】段（ai-hedge-fund `druckenmiller.py:56-59`）
 * - 置信度永远 60-70 → 改为**可数锚定**：由代码统计指标一致性并给出上限
 *   （A_Share `technicals.py:134-136`、TradingAgents `schemas.py:304-311`）
 * - 目标价一律留空 → **双轨**：有锚必给推导，无锚须显式说明理由（dexter `SKILL.md:72-89`）；
 *   并新增失效位（invalidation）让结论可执行
 * - 结尾"综上所述" → **删掉 conclusion 段**，换成 `what_would_change_my_mind` + `monitoring`
 *   （dexter `memo-style.md:80-88`）
 * - 推理常见谬误 → 具名谬误清单（A_Share `debate_room/system.md:26-31`）+ 输出前自检
 *   （dexter `SKILL.md:142-153`，同一次调用内完成，不额外计费）
 */

const SYSTEM_PROMPT = `你是一位严谨的 A 股投研分析师，以长期价值与风险的平衡视角评估单只股票。
你的读者是有经验的投资者：他们要的是可核查的推理与可执行的结论，不是描述性复述。

【推理清单】请按顺序完成，再给结论：
1. 估值与盈利质量（**本次已提供财报与历史估值分位，必须用上**）：
   - 当前 PE/PB 处于近 3 年、近 5 年的什么分位？「便宜」是否有历史依据？
   - 相对同行业是贵还是便宜？若「相对自身历史极低、相对同业并不便宜」，说明什么？
   - 用财报数据核对：ROE、毛利率、净利率、资产负债率的最新值与**趋势**（对比历史期间）
   - 营收与净利同比增速是正还是负？低估值是**错杀**（盈利仍增长）还是**盈利下修的定价**（增速转负）？
   - 由 PE/PB 推出的隐含 ROE 与财报实际 ROE 是否互相印证？
2. 趋势结构：最新价相对 SMA50 / SMA200 的位置与偏离幅度，均线是多头还是空头排列？
3. 动能与摆动：MACD 的 DIF/DEA/柱状图关系如何演化？RSI 处于什么区间，是否存在极端读数？
4. 波动与位置：ATR 与年化波动率反映的波动强度；价格处于近期区间的什么位置？
5. 多空对照：先写出**最强的多头论据**，再写出**最强的空头论据**，最后说明哪一方更强、为什么。
6. 结论：给出 5 档评级，并明确「什么情况下这个判断会被证伪」。

【评级规则】
- buy：多数维度明确向好，风险可控，估值与趋势不冲突
- overweight：偏正面但有保留（如趋势好而估值偏高）
- hold：多空论据**势均力敌且各自成立**——选择 hold 必须写明多头与空头各自的支撑点，
  不允许因为"看不清"或"数据不足"而选 hold（那是 abstain 的语义，请用 data_limits 表达）
- underweight：偏负面但有保留（如估值便宜但趋势走弱）
- sell：多数维度明确恶化，或存在显著下行风险

【置信度规则（必须遵守）】
置信度衡量的是**证据强度**，不是你的态度强度。系统已按 12 项指标的客观方向统计了一致性，
并在数据区给出 \`confidence 上限\`。你的 confidence **不得超过该上限**。
参考锚点：
- 一致性 ≥90%：90-100（各维度高度一致）
- 一致性 75-89%：70-89
- 一致性 60-74%：50-69
- 一致性 50-59%：40-49（多空分歧，不应给高分）
- 输入数据缺失维度较多时，进一步下调

【目标价规则（双轨，不得违反）】
- 若数据足以支撑估值判断：给出 price_target，并在 price_target_basis 中写明**推导路径**
  （例如：以隐含 EPS × 合理 PE 区间推导，或以前期成交密集区作为锚）
- 若数据不足以给出目标价：price_target 置 null，并在 price_target_basis 中写明**具体缺什么数据**，
  禁止给一个没有推导路径的数字
- 无论是否给出目标价，都必须给出 invalidation（判断失效位）：从「近期区间低点 / SMA50 / SMA200 /
  最新价 − 2×ATR」中选最贴近当前价的一个，说明依据并给出距当前价的百分比

【必须避免的推理谬误】（输出前逐条自查）
- 线性外推：把近 20 日走势直接当作未来走势，忽略均值回归与基数效应
- 忽略基数：把低基数下的高增速当成高成长
- 相关当因果：把同步发生的现象说成因果关系
- 选择性用数：只引用支持自己结论的指标，回避反向证据
- 把"估值低"直接等同于"会上涨"——低估值可能是盈利下修的定价结果
- 用"可能""或许""不排除"堆砌模糊结论而不给出可观察条件

【硬规则】
- 只依据【数据】部分的内容推理；数据中没有的信息不要声称，**绝不编造任何数字**
- 把「数据截至日」当作今天；不要假设此后发生了任何事情
- 形态描述必须与给出的价格序列一致，不要虚构价格点位
- 数据缺失的维度，统一在 data_limits 中声明，**不要在每个段落反复说"数据不足"**
- 对缺失维度，若能用现有数据做合理代理推断（如用 PB/PE 推 ROE），应当推断并说明是推断
- 只输出 JSON，不要输出任何解释性文字，不要使用 markdown 代码块包裹

【输出前的自检清单】逐条确认后再输出：
1. 每个技术面论断是否都引用了数据区中的具体数值？
2. fundamentals 是否达到了规定的篇幅与深度（不是三句话带过）？
3. 是否写出了最强多头与最强空头两方论据？
4. confidence 是否不超过数据区给出的上限？
5. 目标价与失效位是否都给出了依据（或明确说明缺什么数据）？
6. data_limits 是否如实列出了本次未提供的数据维度？
7. reasoning 是否是 1-2 句的完整判断（而非"综上所述"式套话）？

【输出 JSON 结构（严格遵循，字段不可增删改名）】
{
  "rating": "buy" | "overweight" | "hold" | "underweight" | "sell",
  "confidence": <0-100 的整数，不得超过数据区给出的上限>,
  "reasoning": "<1-2 句核心判断，必须包含方向与最关键的理由>",
  "price_target": <数字 或 null>,
  "price_target_basis": "<推导路径，或说明缺什么数据；不得为空>",
  "time_horizon": "<如 '3-6 个月'，或 null>",
  "invalidation": {
    "price": <数字>,
    "basis": "<区间低点 | SMA50 | SMA200 | 价-2ATR 之一，并说明为何选它>",
    "distance_percent": <距离当前价的百分比，正数表示需下跌，负数表示需上涨>
  },
  "sections": {
    "snapshot": "<公司与数据快照的事实陈述，2-3 句>",
    "fundamentals": "<估值与盈利质量评估，**至少 300 字**，按 WHY（为什么这个估值水平）→ WHAT（隐含 ROE/EPS 说明了什么）→ HOW（与趋势是否冲突）→ SO WHAT（对投资决策意味着什么）展开，须引用具体数值>",
    "technicals": "<趋势/动能/波动/位置评估，至少 250 字，须引用具体数值>",
    "risks": ["<风险点 1，须具体可核>", "<风险点 2>", "<风险点 3>"]
  },
  "data_limits": ["<本次未提供的数据维度，及其对结论的限制>"],
  "what_would_change_my_mind": "<什么可观察的信号出现会让你改变上述评级>",
  "monitoring": ["<后续需持续跟踪的指标与阈值>"]
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

/** 渲染隐含估值量（由 PE/PB 推导，零外部数据）。 */
function renderImplied(input: AnalysisInput): string {
  const v = input.implied;
  if (!v) return "（无数据）";
  return [
    `隐含 ROE（PB/PE）：${v.impliedRoe === null ? "无数据" : `${v.impliedRoe.toFixed(2)}%`}`,
    `隐含每股收益（价/PE）：${n(v.impliedEps)} 元`,
    `隐含每股净资产（价/PB）：${n(v.impliedBvps)} 元`,
    `隐含净利润（市值/PE）：${big(v.impliedNetProfit)}`,
    `隐含净资产（市值/PB）：${big(v.impliedEquity)}`,
    "（以上均由 PE/PB 数学推导，非财报原始数据；请在分析中注明其为推断值）",
  ].join("\n");
}

/** 渲染多空一致性统计（供模型校准 confidence）。 */
function renderTally(tally: SignalTally | undefined): string {
  if (!tally) return "（无信号统计）";
  const detail = tally.items
    .map((i) => {
      const label = i.direction === "bullish" ? "看多" : i.direction === "bearish" ? "看空" : "中性";
      return `- ${i.name}：${label}（${i.detail}）`;
    })
    .join("\n");
  return `看多 ${tally.bullish} 项 / 看空 ${tally.bearish} 项 / 中性 ${tally.neutral} 项，共 ${tally.total} 项
一致性比例：${(tally.consistency * 100).toFixed(0)}%
confidence 上限：${tally.maxConfidence}（你的 confidence 不得超过此值）

逐项明细：
${detail}`;
}

/** 亿元化（保留两位）。 */
function yi(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return (v / 1e8).toFixed(2);
}

/** 渲染最近若干期财报主指标（年内累计口径）。 */
function renderFinancials(input: AnalysisInput): string {
  const f = input.fundamentals;
  if (!f || f.periods.length === 0) return "（财务数据获取失败或不可用）";

  const header =
    "报告期 | 营收(亿) | 营收同比% | 归母净利(亿) | 净利同比% | ROE% | 毛利率% | 净利率% | 负债率% | EPS | BPS | 每股现金流";
  const rows = f.periods.slice(0, 6).map((p) =>
    [
      p.reportName,
      yi(p.revenue),
      n(p.revenueYoy),
      yi(p.netProfit),
      n(p.netProfitYoy),
      n(p.roe),
      n(p.grossMargin),
      n(p.netMargin),
      n(p.debtRatio),
      n(p.eps),
      n(p.bps),
      n(p.ocfPerShare),
    ].join(" | "),
  );
  return `${[header, ...rows].join("\n")}\n（口径说明：以上为**年内累计（YTD）**，非单季；金额单位已换算为亿元）`;
}

/** 渲染历史估值分位（回答「估值是高是低」）。 */
function renderValuation(input: AnalysisInput): string {
  const v = input.fundamentals?.valuation;
  if (!v) return "（估值历史数据不可用）";

  const line = (name: string, m: { current: number | null; y3: PercentileLike; y5: PercentileLike }) => {
    if (m.current === null) return `${name}：当前值缺失`;
    const parts = [`当前 ${m.current}`];
    parts.push(
      m.y3
        ? `近3年 ${m.y3.percentile}% 分位（区间 ${m.y3.min}–${m.y3.max}，中位 ${m.y3.median}，样本 ${m.y3.samples} 日）`
        : "近3年样本不足",
    );
    parts.push(m.y5 ? `近5年 ${m.y5.percentile}% 分位` : "近5年样本不足");
    return `${name}：${parts.join("；")}`;
  };

  const industry = input.fundamentals?.industry;
  return [
    line("PE_TTM", v.pe),
    line("PB_MRQ", v.pb),
    `数据截至 ${v.asOf ?? "未知"}`,
    industry ? `所属行业：${industry}` : "所属行业：未知",
    "（分位数越低表示越接近历史低估区间；<20% 通常属历史低位，>80% 属历史高位）",
  ].join("\n");
}

/** 渲染同业估值对比（行业内相对贵贱）。 */
function renderPeers(input: AnalysisInput): string {
  const p = input.fundamentals?.peers;
  if (!p) return "（同业对比数据不可用）";

  const lines: string[] = [`行业：${p.industry}（板块共 ${p.peerCount} 只，交易日 ${p.tradeDate}）`];

  if (p.pe) {
    lines.push(
      `行业 PE_TTM 中位 ${p.pe.median}（25 分位 ${p.pe.p25}／75 分位 ${p.pe.p75}，区间 ${p.pe.min}–${p.pe.max}，有效样本 ${p.pe.count} 只）`,
    );
  }
  if (p.pb) {
    lines.push(`行业 PB_MRQ 中位 ${p.pb.median}（有效样本 ${p.pb.count} 只）`);
  }
  if (p.peRank !== null && p.cheaperPeers !== null) {
    lines.push(
      `本股 PE 在 ${p.peerCount} 只同业中排第 ${p.peRank} 低（有 ${p.cheaperPeers} 只比它更便宜）`,
    );
  }
  if (p.pePremium !== null) {
    lines.push(
      `本股 PE 相对行业中位${p.pePremium > 0 ? "溢价" : "折价"} ${Math.abs(p.pePremium)}%` +
        (p.pbPremium !== null
          ? `；PB 相对行业中位${p.pbPremium > 0 ? "溢价" : "折价"} ${Math.abs(p.pbPremium)}%`
          : ""),
    );
  }
  lines.push("（用于判断「便宜」是相对自身历史还是相对同业，两者可能背离）");
  return lines.join("\n");
}

type PercentileLike =
  | { percentile: number; min: number; median: number; max: number; samples: number }
  | null;

/**
 * 动态数据边界：按**实际提供**的数据生成，避免声明了其实已有的数据
 * （此前模型反复说"未提供历史估值分位"，而该数据其实可得）。
 */
function buildDataLimits(input: AnalysisInput): string {
  const provided = ["行情快照", "派生技术指标（12 项）", "隐含估值量", "多空一致性统计", "价格序列"];
  const missing: string[] = [];

  if (input.fundamentals?.periods?.length) {
    provided.push(`财务主指标（近 ${input.fundamentals.periods.length} 期，年内累计口径）`);
  } else {
    missing.push("财务报表明细（营收、毛利率、净利率、现金流、资产负债率、利润增速）");
  }

  if (input.fundamentals?.valuation?.pe?.y3) {
    provided.push("历史估值分位（PE/PB 近 3 年与近 5 年）");
  } else {
    missing.push("历史估值分位（当前 PE/PB 在自身历史的百分位）");
  }

  if (input.fundamentals?.industry) {
    provided.push(`所属行业（${input.fundamentals.industry}）`);
  }

  if (input.fundamentals?.peers) {
    provided.push("同业估值对比（行业 PE/PB 中位与个股在行业内的排名）");
  } else {
    missing.push("同业估值对比（行业平均估值倍数，无法做横向比价）");
  }

  missing.push(
    "资金流向（主力净流入）、融资余额、股东户数变化",
    "新闻、公告、事件与催化剂、业绩预告",
    "宏观经济与政策环境数据",
  );

  return `本次**已提供**：${provided.join("、")}。
本次**未提供**（不要假装拥有，也不要用常识填补）：
${missing.map((m) => `- ${m}`).join("\n")}`;
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

三、隐含估值量（由 PE/PB 数学推导，零外部数据）
${renderImplied(input)}

四、财务主指标（东方财富数据中心）
${renderFinancials(input)}

五、历史估值分位（回答「估值相对自身历史是高是低」）
${renderValuation(input)}

六、同业估值对比（回答「估值相对同行业是贵是贱」）
${renderPeers(input)}

七、多空信号一致性统计（系统按客观方向统计，用于校准你的 confidence）
${renderTally(input.tally)}

八、近 ${input.klines.length} 个交易日价格序列（前复权）
${renderKlines(input)}

九、【数据边界】
${buildDataLimits(input)}

请依据以上数据，按系统提示的推理清单与规则完成分析，只输出 JSON。`;

  return { system: SYSTEM_PROMPT, user };
}

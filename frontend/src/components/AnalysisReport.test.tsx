import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalysisReport from "./AnalysisReport";
import type { Analysis } from "../types";

const analysis: Analysis = {
  rating: "overweight",
  confidence: 72,
  reasoning: "估值偏低但趋势尚未反转",
  priceTarget: 1400,
  priceTargetBasis: "隐含 EPS 71.23 × 合理 PE 19-20",
  timeHorizon: "3-6 个月",
  invalidation: { price: 1151.01, basis: "近期区间低点", distancePercent: 8.4 },
  sections: {
    snapshot: "贵州茅台，白酒龙头。",
    fundamentals: "PE 17.65，估值中性偏低。",
    technicals: "价格低于 SMA50，MACD 柱为负。",
    risks: ["趋势仍处下行", "换手率偏低"],
  },
  dataLimits: ["未提供财报明细", "未提供历史估值分位"],
  whatWouldChangeMyMind: "若价格站稳 SMA50 且 MACD 柱转正",
  monitoring: ["MACD 柱是否收敛", "换手率是否放大"],
};

describe("AnalysisReport 正文四节", () => {
  it("渲染四个分节标题", () => {
    render(<AnalysisReport analysis={analysis} />);
    expect(screen.getByText("① 公司与数据快照")).toBeInTheDocument();
    expect(screen.getByText("② 基本面评估")).toBeInTheDocument();
    expect(screen.getByText("③ 技术面评估")).toBeInTheDocument();
    expect(screen.getByText("④ 风险点清单")).toBeInTheDocument();
  });

  it("不再渲染 conclusion 段（已按调研结论删除）", () => {
    render(<AnalysisReport analysis={analysis} />);
    expect(screen.queryByText(/结论与目标区间/)).not.toBeInTheDocument();
  });

  it("各节正文正确归位", () => {
    render(<AnalysisReport analysis={analysis} />);
    expect(screen.getByText("贵州茅台，白酒龙头。")).toBeInTheDocument();
    expect(screen.getByText("PE 17.65，估值中性偏低。")).toBeInTheDocument();
    expect(screen.getByText("趋势仍处下行")).toBeInTheDocument();
  });

  it("节内容缺失时给出占位而非空白", () => {
    render(
      <AnalysisReport
        analysis={{
          ...analysis,
          sections: { snapshot: "", fundamentals: "", technicals: "", risks: [] },
        }}
      />,
    );
    expect(screen.getAllByText("（模型未提供该节内容）")).toHaveLength(3);
    expect(screen.getByText("（模型未列出风险点）")).toBeInTheDocument();
  });
});

describe("AnalysisReport 的三个收尾块", () => {
  it("展示数据边界（缺失维度集中说明）", () => {
    render(<AnalysisReport analysis={analysis} />);
    const block = screen.getByTestId("data-limits");
    expect(block).toHaveTextContent("数据边界与局限");
    expect(block).toHaveTextContent("未提供历史估值分位");
  });

  it("展示证伪条件（什么会改变判断）", () => {
    render(<AnalysisReport analysis={analysis} />);
    expect(screen.getByTestId("change-my-mind")).toHaveTextContent("站稳 SMA50");
  });

  it("展示后续监控指标与阈值", () => {
    render(<AnalysisReport analysis={analysis} />);
    const block = screen.getByTestId("monitoring");
    expect(block).toHaveTextContent("MACD 柱是否收敛");
    expect(block).toHaveTextContent("换手率是否放大");
  });

  it("收尾块全部为空时不渲染整块（不留空壳）", () => {
    render(
      <AnalysisReport
        analysis={{ ...analysis, dataLimits: [], whatWouldChangeMyMind: "", monitoring: [] }}
      />,
    );
    expect(screen.queryByTestId("data-limits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("change-my-mind")).not.toBeInTheDocument();
    expect(screen.queryByTestId("monitoring")).not.toBeInTheDocument();
  });
});

describe("AnalysisReport 的宽度策略", () => {
  it("卡片全宽但正文限宽（超宽屏上长行难读）", () => {
    render(<AnalysisReport analysis={analysis} />);
    expect(screen.getByText("贵州茅台，白酒龙头。").className).toContain("max-w-4xl");
    expect(screen.getAllByRole("list")[0]!.className).toContain("max-w-4xl");
  });

  it("正文限宽不影响卡片容器的全宽", () => {
    const { container } = render(<AnalysisReport analysis={analysis} />);
    const article = container.querySelector("article")!;
    expect(article.className).not.toContain("max-w-4xl");
  });
});

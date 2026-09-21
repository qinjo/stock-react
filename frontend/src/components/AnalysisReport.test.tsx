import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AnalysisReport from "./AnalysisReport";
import type { AnalysisSections } from "../types";

const sections: AnalysisSections = {
  snapshot: "贵州茅台，白酒龙头。",
  fundamentals: "PE 17.65，估值中性偏低。",
  technicals: "价格低于 SMA50，MACD 柱为负。",
  risks: ["趋势仍处下行", "换手率偏低"],
  conclusion: "维持增持，目标区间 1300-1400。",
};

describe("AnalysisReport", () => {
  it("渲染五个分节标题", () => {
    render(<AnalysisReport sections={sections} />);
    expect(screen.getByText("① 公司与数据快照")).toBeInTheDocument();
    expect(screen.getByText("② 基本面评估")).toBeInTheDocument();
    expect(screen.getByText("③ 技术面评估")).toBeInTheDocument();
    expect(screen.getByText("④ 风险点清单")).toBeInTheDocument();
    expect(screen.getByText("⑤ 结论与目标区间")).toBeInTheDocument();
  });

  it("风险点以列表呈现", () => {
    render(<AnalysisReport sections={sections} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("趋势仍处下行");
  });

  it("各节正文正确归位", () => {
    render(<AnalysisReport sections={sections} />);
    expect(screen.getByText("贵州茅台，白酒龙头。")).toBeInTheDocument();
    expect(screen.getByText("PE 17.65，估值中性偏低。")).toBeInTheDocument();
    expect(screen.getByText("维持增持，目标区间 1300-1400。")).toBeInTheDocument();
  });

  it("节内容缺失时给出占位而非空白", () => {
    render(
      <AnalysisReport
        sections={{ snapshot: "", fundamentals: "", technicals: "", risks: [], conclusion: "" }}
      />,
    );
    expect(screen.getAllByText("（模型未提供该节内容）")).toHaveLength(3);
    expect(screen.getByText("（模型未列出风险点）")).toBeInTheDocument();
    expect(screen.getByText("（模型未提供结论）")).toBeInTheDocument();
  });
});

describe("AnalysisReport 的宽度策略", () => {
  it("卡片全宽但正文限宽（超宽屏上长行难读）", () => {
    render(<AnalysisReport sections={sections} />);
    expect(screen.getByText("贵州茅台，白酒龙头。").className).toContain("max-w-4xl");
    expect(screen.getByText("维持增持，目标区间 1300-1400。").className).toContain("max-w-4xl");
    expect(screen.getByRole("list").className).toContain("max-w-4xl");
  });

  it("正文限宽不影响卡片容器的全宽", () => {
    const { container } = render(<AnalysisReport sections={sections} />);
    const article = container.querySelector("article")!;
    expect(article.className).not.toContain("max-w-4xl");
  });
});

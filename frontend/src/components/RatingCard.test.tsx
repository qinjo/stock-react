import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RatingCard from "./RatingCard";
import type { Analysis } from "../types";

const analysis: Analysis = {
  rating: "overweight",
  confidence: 72,
  reasoning: "估值偏低但趋势尚未反转",
  priceTarget: 1400,
  priceTargetBasis: "隐含 EPS 71.23 × 合理 PE 19-20",
  timeHorizon: "3-6 个月",
  invalidation: { price: 1151.01, basis: "近期区间低点", distancePercent: 8.4 },
  sections: { snapshot: "s", fundamentals: "f", technicals: "t", risks: [] },
  dataLimits: ["未提供财报明细"],
  whatWouldChangeMyMind: "站上 SMA50 且 MACD 转正",
  monitoring: ["MACD 柱是否收敛"],
};

describe("RatingCard", () => {
  it("展示中文评级徽章与置信度数值", () => {
    render(<RatingCard analysis={analysis} model="deepseek-chat" analyzedAt="2026-08-30T10:00:00.000Z" fromCache={false} />);
    expect(screen.getByTestId("rating-badge")).toHaveTextContent("增持");
    expect(screen.getByText("72")).toBeInTheDocument();
  });

  it("置信度条宽度与数值一致", () => {
    render(<RatingCard analysis={analysis} model="deepseek-chat" analyzedAt="2026-08-30T10:00:00.000Z" fromCache={false} />);
    const bar = screen.getByRole("progressbar", { name: "置信度" });
    expect(bar).toHaveAttribute("aria-valuenow", "72");
    expect(bar).toHaveStyle({ width: "72%" });
  });

  it("展示目标价与时间窗", () => {
    render(<RatingCard analysis={analysis} model="deepseek-chat" analyzedAt="2026-08-30T10:00:00.000Z" fromCache={false} />);
    expect(screen.getByText("1400")).toBeInTheDocument();
    expect(screen.getByText("3-6 个月")).toBeInTheDocument();
  });

  it("目标价/时间窗为 null 时不渲染数值，但保留依据说明（双轨规则的要求）", () => {
    render(
      <RatingCard
        analysis={{ ...analysis, priceTarget: null, timeHorizon: null }}
        model="deepseek-chat"
        analyzedAt="2026-08-30T10:00:00.000Z"
        fromCache={false}
      />,
    );
    // 数值字段不渲染
    expect(screen.queryByText("1400")).not.toBeInTheDocument();
    expect(screen.queryByText(/时间窗/)).not.toBeInTheDocument();
    // 但"为什么没有目标价"必须说明（这是新 schema 的双轨要求）
    expect(screen.getByTestId("price-target-basis")).toBeInTheDocument();
    expect(screen.queryByText(/null|undefined/)).not.toBeInTheDocument();
  });

  it("展示判断失效位与其依据（结论可执行）", () => {
    render(
      <RatingCard
        analysis={analysis}
        model="deepseek-chat"
        analyzedAt="2026-08-30T10:00:00.000Z"
        fromCache={false}
      />,
    );
    expect(screen.getByTestId("invalidation")).toHaveTextContent("1151.01");
    expect(screen.getByTestId("invalidation-basis")).toHaveTextContent("近期区间低点");
  });

  it("展示模型、时间与缓存标记（结果可溯源）", () => {
    render(<RatingCard analysis={analysis} model="deepseek-chat" analyzedAt="2026-08-30T10:00:00.000Z" fromCache />);
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument();
    expect(screen.getByText(/命中缓存/)).toBeInTheDocument();
  });

  it("5 档评级均可渲染对应中文", () => {
    const cases: Array<[Analysis["rating"], string]> = [
      ["buy", "买入"],
      ["overweight", "增持"],
      ["hold", "持有"],
      ["underweight", "减持"],
      ["sell", "卖出"],
    ];
    for (const [rating, label] of cases) {
      const { unmount } = render(
        <RatingCard
          analysis={{ ...analysis, rating }}
          model="m"
          analyzedAt="2026-08-30T10:00:00.000Z"
          fromCache={false}
        />,
      );
      expect(screen.getByTestId("rating-badge")).toHaveTextContent(label);
      unmount();
    }
  });
});

describe("RatingCard 的 token 用量展示", () => {
  const base = { analysis, model: "deepseek-chat", analyzedAt: "2026-08-30T10:00:00.000Z" };

  it("展示总用量与输入/输出明细（千分位）", () => {
    render(
      <RatingCard
        {...base}
        fromCache={false}
        usage={{ promptTokens: 2686, completionTokens: 612, totalTokens: 3298, cachedTokens: 2432 }}
      />,
    );
    const usageLine = screen.getByTestId("token-usage");
    expect(usageLine).toHaveTextContent("3,298 tokens");
    expect(usageLine).toHaveTextContent("输入 2,686");
    expect(usageLine).toHaveTextContent("输出 612");
  });

  it("有缓存命中 token 时额外说明（成本更低）", () => {
    render(
      <RatingCard
        {...base}
        fromCache={false}
        usage={{ promptTokens: 2686, completionTokens: 612, totalTokens: 3298, cachedTokens: 2432 }}
      />,
    );
    expect(screen.getByTestId("token-usage")).toHaveTextContent("2,432 命中提示词缓存");
  });

  it("用量缺失时不渲染该行（不显示 0 或 undefined）", () => {
    render(<RatingCard {...base} fromCache={false} />);
    expect(screen.queryByTestId("token-usage")).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined|NaN/)).not.toBeInTheDocument();
  });
});

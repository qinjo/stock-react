import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RatingCard from "./RatingCard";
import type { Analysis } from "../types";

const analysis: Analysis = {
  rating: "overweight",
  confidence: 72,
  reasoning: "估值偏低但趋势尚未反转",
  priceTarget: 1400,
  timeHorizon: "3-6 个月",
  sections: { snapshot: "s", fundamentals: "f", technicals: "t", risks: [], conclusion: "c" },
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

  it("目标价/时间窗为 null 时不渲染对应字段（而非显示 null）", () => {
    render(
      <RatingCard
        analysis={{ ...analysis, priceTarget: null, timeHorizon: null }}
        model="deepseek-chat"
        analyzedAt="2026-08-30T10:00:00.000Z"
        fromCache={false}
      />,
    );
    expect(screen.queryByText(/目标价/)).not.toBeInTheDocument();
    expect(screen.queryByText(/时间窗/)).not.toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
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

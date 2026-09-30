import type { BoardName, ScreenMode, Strictness } from "../../types";

/** 放宽的下一档；已是最宽档则为 null（不能再放宽）。 */
export const NEXT_LOOSER: Record<Strictness, Strictness | null> = {
  strict: "standard",
  standard: "loose",
  loose: null,
};

/** 模式 / 严格度 / 板块的中文标签与顺序。 */

export const MODE_LABELS: Array<{ value: ScreenMode; label: string; hint: string }> = [
  { value: "trend", label: "均线跟随", hint: "站上 MA100 的均线结构" },
  { value: "event", label: "事件驱动", hint: "缺口与涨停突破" },
];

export const STRICTNESS_LABELS: Array<{ value: Strictness; label: string }> = [
  { value: "loose", label: "宽松" },
  { value: "standard", label: "标准" },
  { value: "strict", label: "严格" },
];

export const BOARD_LABELS: Array<{ value: BoardName; label: string }> = [
  { value: "main", label: "主板" },
  { value: "growth", label: "创业板" },
  { value: "star", label: "科创板" },
  { value: "bj", label: "北交所" },
];

export const DEFAULT_BOARDS: BoardName[] = ["main", "growth", "star"];

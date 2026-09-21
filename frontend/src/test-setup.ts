import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// klinecharts 依赖 canvas 文本测量（jsdom 不支持），测试环境用轻量 stub 替换。
// 图表组件的行为测试聚焦「数据转换」与「容器渲染」，不依赖真实绘制。
vi.mock("klinecharts", () => {
  const chart = {
    setDataLoader: vi.fn(),
    createIndicator: vi.fn(),
    setSymbol: vi.fn(),
    setPeriod: vi.fn(),
    resize: vi.fn(),
  };
  return {
    init: vi.fn(() => chart),
    dispose: vi.fn(),
  };
});
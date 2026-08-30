import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "./App";

const okHealth = {
  ok: true,
  json: () =>
    Promise.resolve({ status: "ok", service: "stock-backend", time: "2026-08-30T08:00:00.000Z" }),
};

beforeEach(() => {
  // 每个测试都 stub fetch，避免真实请求在 jsdom 中抛错导致 act 警告
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okHealth));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App 入口页", () => {
  it("渲染查询入口与标题", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "A股智能分析" })).toBeInTheDocument();
    expect(screen.getByLabelText("股票代码 / 名称")).toBeInTheDocument();
  });

  it("后端健康时显示连通状态", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/stock-backend · ok/)).toBeInTheDocument();
    });
  });

  it("后端不可用时显示错误提示", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("无法连接后端");
    });
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/datasource.js", () => ({ fetchQuote: vi.fn() }));
vi.mock("../src/fundamentals.js", () => ({ fetchFundamentals: vi.fn() }));

import { buildApp } from "../src/app.js";
import { fetchQuote } from "../src/datasource.js";
import { fetchFundamentals } from "../src/fundamentals.js";
import type { Quote } from "../src/domain.js";

const quote = { code: "600519", name: "贵州茅台", pe: 17.6, pb: 6.24 } as Quote;

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/fundamentals", () => {
  it("缺少 code 返回 400", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/fundamentals" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_INPUT");
  });

  it("用行情的 PE/PB 作为当前值计算分位", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchFundamentals).mockResolvedValue({
      periods: [],
      valuation: { asOf: "2026-09-18", pe: { current: 17.6, y3: null, y5: null }, pb: { current: 6.24, y3: null, y5: null } },
      industry: "白酒Ⅱ",
      peers: null,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/fundamentals?code=600519" });

    expect(res.statusCode).toBe(200);
    expect(res.json().fundamentals.industry).toBe("白酒Ⅱ");
    expect(fetchFundamentals).toHaveBeenCalledWith("600519", 17.6, 6.24);
  });

  it("行情失败时仍尝试基本面（当前值退化为 null）", async () => {
    vi.mocked(fetchQuote).mockRejectedValue(new Error("数据源不可用"));
    vi.mocked(fetchFundamentals).mockResolvedValue({
      periods: [],
      valuation: { asOf: null, pe: { current: null, y3: null, y5: null }, pb: { current: null, y3: null, y5: null } },
      industry: null,
    });

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/fundamentals?code=600519" });

    expect(res.statusCode).toBe(200);
    expect(fetchFundamentals).toHaveBeenCalledWith("600519", null, null);
  });

  it("基本面源故障返回 502", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchFundamentals).mockRejectedValue(new Error("数据中心不可用"));

    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/fundamentals?code=600519" });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("SOURCE_UNAVAILABLE");
  });
});

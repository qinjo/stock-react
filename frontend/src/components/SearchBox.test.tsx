import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchBox from "./SearchBox";

const candidates = [
  { code: "600519", name: "贵州茅台", secid: "1.600519", market: "沪A", pinyin: "GZMT" },
  { code: "000858", name: "五粮液", secid: "0.000858", market: "深A", pinyin: "WLY" },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SearchBox", () => {
  it("输入后经防抖请求补全并展示候选（含代码与市场）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchBox onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅");

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("贵州茅台");
    expect(options[0]).toHaveTextContent("600519");
    expect(options[0]).toHaveTextContent("沪A");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/search?q=%E8%8C%85"),
      expect.anything(),
    );
  });

  it("点击候选项触发 onSelect 并显示所选名称", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ candidates }),
      } as Response),
    );
    const onSelect = vi.fn();

    render(<SearchBox onSelect={onSelect} />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    expect(onSelect).toHaveBeenCalledWith(candidates[0]);
    expect(screen.getByLabelText("股票代码 / 名称")).toHaveValue("贵州茅台（600519）");
  });

  it("键盘方向键 + 回车可选中候选", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ candidates }),
      } as Response),
    );
    const onSelect = vi.fn();

    render(<SearchBox onSelect={onSelect} />);
    const input = screen.getByLabelText("股票代码 / 名称");
    await userEvent.type(input, "茅台");
    await screen.findAllByRole("option");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(candidates[1]);
    });
  });

  it("空输入不发起请求且不展示下拉", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchBox onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "   ");
    await userEvent.keyboard("{Enter}");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

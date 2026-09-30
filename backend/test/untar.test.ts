import { describe, expect, it } from "vitest";
import { readTar, stripTopLevelDir } from "../src/market/untar.js";
import { END_BLOCKS, chunked, tarEntry } from "./helpers/tar-builder.js";

async function collect(source: AsyncIterable<Buffer>): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = [];
  for await (const entry of readTar(source)) {
    out.push({ name: entry.name, text: entry.data.toString("utf8") });
  }
  return out;
}

describe("readTar", () => {
  const archive = Buffer.concat([
    tarEntry("qlib_bin/calendars/day.txt", "2026-09-28\n2026-09-29\n"),
    tarEntry("qlib_bin/instruments/all.txt", "SH600519\t2001-08-27\t2026-09-29\n"),
    tarEntry("qlib_bin/features/sh600519/close.day.bin", Buffer.from([0, 0, 0, 0])),
    END_BLOCKS,
  ]);

  it("读出成员的名字与内容", async () => {
    const entries = await collect(chunked(archive, archive.length));
    expect(entries.map((e) => e.name)).toEqual([
      "qlib_bin/calendars/day.txt",
      "qlib_bin/instruments/all.txt",
      "qlib_bin/features/sh600519/close.day.bin",
    ]);
    expect(entries[0]?.text).toBe("2026-09-28\n2026-09-29\n");
  });

  it("输入分块不对齐 512 字节也能正确解析（流式读的核心约束）", async () => {
    for (const size of [1, 7, 511, 513, 1000]) {
      const entries = await collect(chunked(archive, size));
      expect(entries, `chunk=${size}`).toHaveLength(3);
      expect(entries[1]?.text, `chunk=${size}`).toContain("SH600519");
    }
  });

  it("没有结束块时，数据耗尽即正常结束", async () => {
    const noEnd = Buffer.concat([
      tarEntry("qlib_bin/calendars/day.txt", "2026-09-29\n"),
    ]);
    const entries = await collect(chunked(noEnd, 300));
    expect(entries).toHaveLength(1);
  });

  it("成员被截断时抛错，而不是静默返回半个文件", async () => {
    const truncated = Buffer.concat([
      tarEntry("qlib_bin/calendars/day.txt", "x".repeat(2000)),
      END_BLOCKS,
    ]).subarray(0, 512 + 1024); // 头 + 部分数据
    await expect(collect(chunked(truncated, 256))).rejects.toThrow(/截断/);
  });

  it("跳过目录等非普通文件成员", async () => {
    const withDir = Buffer.concat([
      tarEntry("qlib_bin/", "", "5"),
      tarEntry("qlib_bin/calendars/day.txt", "2026-09-29\n"),
      END_BLOCKS,
    ]);
    const entries = await collect(chunked(withDir, 128));
    expect(entries.map((e) => e.name)).toEqual(["qlib_bin/calendars/day.txt"]);
  });

  it("支持 GNU 长文件名（type L）", async () => {
    const longPath = `qlib_bin/features/sh600519/${"f".repeat(120)}.day.bin`;
    const withLongName = Buffer.concat([
      tarEntry("././@LongLink", `${longPath}\0`, "L"),
      tarEntry("qlib_bin/features/sh600519/truncated-name", "data"),
      END_BLOCKS,
    ]);
    const entries = await collect(chunked(withLongName, 256));
    expect(entries.map((e) => e.name)).toEqual([longPath]);
  });

  it("去掉成员名开头的 ./（GNU tar 会加）", async () => {
    const dotted = Buffer.concat([
      tarEntry("./qlib_bin/calendars/day.txt", "2026-09-29\n"),
      END_BLOCKS,
    ]);
    const entries = await collect(chunked(dotted, 512));
    expect(entries.map((e) => e.name)).toEqual(["qlib_bin/calendars/day.txt"]);
  });
});

describe("stripTopLevelDir", () => {
  it("去掉归档顶层目录", () => {
    expect(stripTopLevelDir("qlib_bin/calendars/day.txt")).toBe("calendars/day.txt");
  });

  it("没有目录层级时返回 null（调用方据此跳过）", () => {
    expect(stripTopLevelDir("README.md")).toBeNull();
  });
});

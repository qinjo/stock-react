import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestArchive, parseReleaseTag, readCalendarAndInstruments } from "../src/market/bootstrap.js";
import { MarketStore } from "../src/market/store.js";
import { featureBin, tarArchive } from "./helpers/tar-builder.js";

/**
 * 用**合成的极小归档**端到端跑 bootstrap：结构、字段语义、年月过滤、
 * 指数与个股分流、异常数据拒绝，全部在这里固定下来，且不触网、不依赖 541 MB 真实数据集。
 */

const CALENDAR = ["2019-01-02", "2019-01-03", "2026-09-25", "2026-09-28", "2026-09-29"];
const LATEST = "2026-09-29";

const INSTRUMENTS = [
  "SH600519\t2001-08-27\t2026-09-29",
  "SZ000001\t1991-04-03\t2026-09-29",
  "BJ920002\t2023-05-31\t2026-09-29",
  "SH688981\t2019-07-22\t2026-09-20", // 截止日早于最新交易日 → 已不在交易
  "SH000300\t2005-01-04\t2026-09-29", // 指数，应进 index_bars
].join("\n");

/** 构造 7 条特征序列。factor 恒定、价格按 raw = scaled / factor 设计。 */
function quoteFields(
  dir: string,
  rawClose: number[],
  opts: { factor?: number; rawVolume?: number; rawAmount?: number } = {},
): Array<[string, Buffer]> {
  const factor = opts.factor ?? 0.5;
  const rawVolume = opts.rawVolume ?? 1000;
  const rawAmount = opts.rawAmount ?? 1_000_000;
  const scaled = (raw: number) => raw * factor;
  return [
    [`qlib_bin/features/${dir}/open.day.bin`, featureBin(0, rawClose.map((c) => scaled(c - 5)))],
    [`qlib_bin/features/${dir}/high.day.bin`, featureBin(0, rawClose.map((c) => scaled(c + 10)))],
    [`qlib_bin/features/${dir}/low.day.bin`, featureBin(0, rawClose.map((c) => scaled(c - 10)))],
    [`qlib_bin/features/${dir}/close.day.bin`, featureBin(0, rawClose.map(scaled))],
    // 不开复权的成交量与成交额：raw 手 = scaled × factor，raw 元 = scaled × 1000
    [`qlib_bin/features/${dir}/volume.day.bin`, featureBin(0, rawClose.map(() => rawVolume / factor))],
    [`qlib_bin/features/${dir}/amount.day.bin`, featureBin(0, rawClose.map(() => rawAmount / 1000))],
    [`qlib_bin/features/${dir}/factor.day.bin`, featureBin(0, rawClose.map(() => factor))],
  ];
}

const MAOTAI_RAW_CLOSE = [1100, 1110, 1230, 1243.88, 1235.58];
const INDEX_RAW_CLOSE = [3000, 3010, 3800, 3840, 3860];

function buildArchive(extra: Array<[string, Buffer | string]> = []): Buffer {
  return gzipSync(
    tarArchive([
      ["qlib_bin/calendars/day.txt", `${CALENDAR.join("\n")}\n`],
      ["qlib_bin/instruments/all.txt", `${INSTRUMENTS}\n`],
      ...quoteFields("sh600519", MAOTAI_RAW_CLOSE),
      ...quoteFields("sh000300", INDEX_RAW_CLOSE, { factor: 1, rawVolume: 100, rawAmount: 200 }),
      ...extra,
    ]),
  );
}

let dir: string;
let tarPath: string;
let store: MarketStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  tarPath = join(dir, "qlib_bin.tar.gz");
  writeFileSync(tarPath, buildArchive([["qlib_bin/features/sz999999/close.day.bin", featureBin(0, [1, 2, 3])]]));
  store = new MarketStore(join(dir, "kline.sqlite"));
  store.migrate();
  store.optimizeForBulkLoad();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("parseReleaseTag", () => {
  it("从 latest/download 的 302 地址里取出 tag", () => {
    expect(
      parseReleaseTag(
        "https://github.com/chenditc/investment_data/releases/download/2026-09-29/qlib_bin.tar.gz",
      ),
    ).toBe("2026-09-29");
  });

  it("拿到跟随跳转后的签名资产地址时明确失败（这正是最初的 bug）", () => {
    // 一旦用 curl -L，url_effective 会变成这种带签名的地址，tag 不在其中
    const signed =
      "https://release-assets.githubusercontent.com/github-production-release-asset/515560111/37a803cc" +
      "?sp=r&sv=2018-11-09&sr=b&rscd=attachment%3B+filename%3Dqlib_bin.tar.gz";
    expect(() => parseReleaseTag(signed)).toThrow(/无法从跳转地址解析 tag/);
  });
});

describe("readCalendarAndInstruments", () => {
  it("取到日历与清单，并按年数算出起始日期键", async () => {
    const prepared = await readCalendarAndInstruments(tarPath, 6);
    expect(prepared.calendar).toEqual(CALENDAR);
    expect(prepared.latestDate).toBe(LATEST);
    // 2026 - 6 = 2020，故自 2020-09-29 起
    expect(prepared.sinceKey).toBe(20200929);
  });
});

describe("ingestArchive 端到端", () => {
  it("写入个股日线、指数分流入库，并统计各类异常", async () => {
    const stats = await ingestArchive(store, tarPath, 6);

    expect(stats).toMatchObject({
      calendarFirst: "2019-01-02",
      latestDate: LATEST,
      tradingDays: 5,
      instruments: 5,
      liveInstruments: 4, // 688981 的截止日早于最新交易日
      instrumentsWritten: 2, // 600519 个股 + sh000300 指数
      unknownDirs: 1, // sz999999 不在清单里
      incompleteInstruments: 0,
      barCount: 3, // 只有 2026 年的 3 根进入 bars
    });
  });

  it("不复权价 = 缩放价 / 因子，且成交量与成交额回到「手」「元」口径", async () => {
    await ingestArchive(store, tarPath, 6);
    const bars = store.readBars("600519");

    expect(bars.map((b) => b.date)).toEqual([20260925, 20260928, 20260929]);
    expect(bars.map((b) => b.close)).toEqual([
      expect.closeTo(1230, 2),
      expect.closeTo(1243.88, 2),
      expect.closeTo(1235.58, 2),
    ]);
    expect(bars[2]?.adjFactor).toBeCloseTo(0.5, 6);
    expect(bars[2]?.volume).toBeCloseTo(1000, 3);
    expect(bars[2]?.amount).toBeCloseTo(1_000_000, 3);
    // 开高低与收盘的相对关系被保留
    expect(bars[2]?.high).toBeCloseTo(1245.58, 2);
    expect(bars[2]?.low).toBeCloseTo(1225.58, 2);
  });

  it("指数进 index_bars，不混进个股日线表", async () => {
    await ingestArchive(store, tarPath, 6);
    expect(store.readIndexBars("sh000300").map((b) => b.close)).toEqual([
      expect.closeTo(3800, 6),
      expect.closeTo(3840, 6),
      expect.closeTo(3860, 6),
    ]);
    expect(store.readBars("000300")).toHaveLength(0);
  });

  it("标的存在性标记与基础信息入表", async () => {
    await ingestArchive(store, tarPath, 6);
    expect(store.countInstruments()).toBe(5);
    expect(store.readInstrument("600519")).toMatchObject({
      market: "sh",
      board: "main",
      isLive: true,
      listedStart: 20010827,
      listedEnd: 20260929,
    });
    expect(store.readInstrument("688981")?.isLive).toBe(false);
    expect(store.readInstrument("920002")?.board).toBe("bj");
  });

  it("最新交易日可从库内推出（供增量刷新比对）", async () => {
    await ingestArchive(store, tarPath, 6);
    expect(store.latestTradeDate()).toBe(20260929);
  });

  it("--years 决定保留范围：10 年时更早的 bar 也保留", async () => {
    const stats = await ingestArchive(store, tarPath, 10);
    expect(stats.barCount).toBe(5);
    expect(store.readBars("600519").map((b) => b.date)).toEqual([
      20190102, 20190103, 20260925, 20260928, 20260929,
    ]);
  });

  it("字段不全的标的被显式统计，而不是静默丢数据", async () => {
    // 只给 open/close，另外 5 个字段永远凑不齐
    writeFileSync(
      tarPath,
      gzipSync(
        tarArchive([
          ["qlib_bin/calendars/day.txt", "2026-09-29\n"],
          ["qlib_bin/instruments/all.txt", "SZ000001\t1991-04-03\t2026-09-29\n"],
          ["qlib_bin/features/sz000001/open.day.bin", featureBin(0, [1])],
          ["qlib_bin/features/sz000001/close.day.bin", featureBin(0, [1])],
        ]),
      ),
    );
    const stats = await ingestArchive(store, tarPath, 6);
    expect(stats.incompleteInstruments).toBe(1);
    expect(stats.barCount).toBe(0);
  });

  it("各序列长度不一致时抛错，而不是猜一个长度", async () => {
    writeFileSync(
      tarPath,
      gzipSync(
        tarArchive([
          ["qlib_bin/calendars/day.txt", "2026-09-28\n2026-09-29\n"],
          ["qlib_bin/instruments/all.txt", "SZ000001\t1991-04-03\t2026-09-29\n"],
          ...quoteFields("sz000001", [10, 11]).map(
            ([name, data]) =>
              // 把 close 砍短，制造不同步
              [name, name.includes("close") ? featureBin(0, [10]) : data] as [string, Buffer],
          ),
        ]),
      ),
    );
    await expect(ingestArchive(store, tarPath, 6)).rejects.toThrow(/不同步/);
  });

  it("缺少交易日历时明确失败", async () => {
    writeFileSync(
      tarPath,
      gzipSync(tarArchive([["qlib_bin/instruments/all.txt", "SZ000001\t1991-04-03\t2026-09-29\n"]])),
    );
    await expect(ingestArchive(store, tarPath, 6)).rejects.toThrow(/交易日历/);
  });
});

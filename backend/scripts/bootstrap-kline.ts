#!/usr/bin/env tsx
/**
 * 本地日K库的一次性 bootstrap（CLI）。
 *
 *   npm run bootstrap:kline                                  # 全市场、近 6 年
 *   npm run bootstrap:kline -- --years 3
 *   npm run bootstrap:kline -- --tar /tmp/qlib_bin.tar.gz    # 用已下载的归档
 *
 * 数据来源是社区维护的 Qlib 格式 dump（每日重建）。**信任边界**：它是第三方产物，
 * 所以下载完必须与发布方 manifest 里的 sha256 逐一核对才允许写库。
 * 上游每天重建、摘要每天都会变，因此默认锚定的是「发布方 manifest」而不是某个写死的摘要；
 * 需要完全可复现时用 `--expect-sha256` 再钉一层。
 *
 * 本文件只负责「下载 + 校验 + 编排」；解析与灌库流水线在 src/market/bootstrap.ts，
 * 那样它才能用合成归档端到端测试。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestArchive, parseReleaseTag } from "../src/market/bootstrap.js";
import { MarketStore } from "../src/market/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = join(HERE, "..");
const RELEASE_BASE = "https://github.com/chenditc/investment_data/releases";
const ARCHIVE_NAME = "qlib_bin.tar.gz";
const MANIFEST_NAME = "qlib_bin.manifest.json";

type Options = {
  out: string;
  years: number;
  tar: string | null;
  expectSha256: string | null;
};

type Manifest = {
  release_tag?: string;
  target_trade_date?: string;
  archive_size_bytes?: number;
  archive_sha256?: string;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    out: join(BACKEND_ROOT, "data", "kline.sqlite"),
    years: 6,
    tar: null,
    expectSha256: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    if (arg === "--out") opts.out = next();
    else if (arg === "--years") opts.years = Number(next());
    else if (arg === "--tar") opts.tar = next();
    else if (arg === "--expect-sha256") opts.expectSha256 = next().replace(/^sha256:/, "");
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "用法：npm run bootstrap:kline -- [选项]",
          "  --out <path>            库文件路径（默认 backend/data/kline.sqlite）",
          "  --years <n>             保留最近 n 年日线（默认 6）",
          "  --tar <path>            使用已下载的归档，跳过下载与校验",
          "  --expect-sha256 <hex>   额外钉死摘要，与 manifest 不一致即失败",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(opts.years) || opts.years <= 0) {
    throw new Error(`--years 必须是正整数，收到 ${opts.years}`);
  }
  return opts;
}

function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) throw new Error(`无法执行 ${cmd}：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${cmd} 退出码 ${result.status}：${(result.stderr ?? "").trim().slice(0, 400)}`);
  }
  return result.stdout ?? "";
}

function requireCurl(): void {
  const probe = spawnSync("curl", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    throw new Error("需要 curl：解析发布 tag 与下载归档都用它（可支持代理与断点续传）");
  }
}

/**
 * 用 curl 取**未跟随跳转**的那次响应地址，从中解析真实 tag。
 * 不走 -L：跟到最后会落到带签名的资产域名，tag 就没了。
 * 也刻意不用 GitHub API——它需要鉴权且按 IP 限流。
 */
function resolveTag(): string {
  const location = run("curl", [
    "-sI",
    "-o",
    "/dev/null",
    "-w",
    "%{redirect_url}",
    `${RELEASE_BASE}/latest/download/${ARCHIVE_NAME}`,
  ]).trim();
  return parseReleaseTag(location);
}

function fetchJson<T>(url: string): T {
  return JSON.parse(run("curl", ["-sL", "--fail", "--max-time", "60", url])) as T;
}

function download(url: string, dest: string): void {
  console.log(`下载归档：${url}`);
  const result = spawnSync(
    "curl",
    ["-L", "--fail", "--retry", "3", "--retry-delay", "3", "-C", "-", "-o", dest, url],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`下载失败（curl 退出码 ${result.status}）`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function bootstrap(opts: Options): Promise<void> {
  const started = Date.now();
  mkdirSync(dirname(opts.out), { recursive: true });

  let tarPath = opts.tar;
  let manifest: Manifest = {};

  if (!tarPath) {
    requireCurl();
    const tag = resolveTag();
    manifest = fetchJson<Manifest>(`${RELEASE_BASE}/download/${tag}/${MANIFEST_NAME}`);
    const published = (manifest.archive_sha256 ?? "").replace(/^sha256:/, "");
    console.log(`发布 tag：${tag}（数据截止 ${manifest.target_trade_date ?? "未知"}）`);

    tarPath = join(dirname(opts.out), `${ARCHIVE_NAME}.${tag}.part`);
    download(`${RELEASE_BASE}/download/${tag}/${ARCHIVE_NAME}`, tarPath);

    const size = statSync(tarPath).size;
    if (manifest.archive_size_bytes && size !== manifest.archive_size_bytes) {
      throw new Error(`归档大小不符：实际 ${size}，manifest 声明 ${manifest.archive_size_bytes}`);
    }
    const actual = await sha256File(tarPath);
    if (published && actual !== published) {
      throw new Error(`sha256 与 manifest 不符：实际 ${actual}，声明 ${published}。拒绝写库。`);
    }
    if (opts.expectSha256 && actual !== opts.expectSha256) {
      throw new Error(`sha256 与 --expect-sha256 不符：实际 ${actual}，声明 ${opts.expectSha256}`);
    }
    console.log(`sha256 校验通过：${actual}`);
    manifest.archive_sha256 = `sha256:${actual}`;
  } else {
    if (!existsSync(tarPath)) throw new Error(`找不到归档：${tarPath}`);
    console.log(`使用已下载归档（未做 sha256 校验）：${tarPath}`);
  }

  rmSync(opts.out, { force: true });
  const store = new MarketStore(opts.out);
  store.migrate();
  store.optimizeForBulkLoad();

  try {
    const stats = await ingestArchive(store, tarPath, opts.years);

    store.setMeta("bootstrap_at", new Date().toISOString());
    store.setMeta("bootstrap_source", manifest.release_tag ?? "local-tar");
    store.setMeta("bootstrap_sha256", manifest.archive_sha256 ?? "unverified");
    store.setMeta("target_trade_date", stats.latestDate);
    store.setMeta("calendar_first", stats.calendarFirst);
    store.setMeta("latest_trade_date", String(store.latestTradeDate() ?? ""));
    store.setMeta("years", String(opts.years));
    store.restoreDurability();

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      [
        "",
        "✓ bootstrap 完成",
        `  库文件        ${opts.out}`,
        `  交易日历      ${stats.tradingDays} 天（${stats.calendarFirst} → ${stats.latestDate}）`,
        `  标的          ${stats.instruments} 只（仍在交易 ${stats.liveInstruments} 只）`,
        `  写入日线      ${stats.instrumentsWritten} 只`,
        `  日K行数       ${stats.barCount.toLocaleString("en-US")}`,
        `  跳过 bar      ${stats.barsSkipped}`,
        `  清单外成员    ${stats.unknownDirs}`,
        `  字段不全      ${stats.incompleteInstruments}`,
        `  最新交易日    ${store.latestTradeDate() ?? "无"}`,
        `  耗时          ${seconds}s`,
      ].join("\n"),
    );
  } finally {
    store.close();
  }

  if (!opts.tar) {
    // 归档约 541 MB，默认用完即删；库留在原地，重建只需再下几十秒
    rmSync(tarPath, { force: true });
  }
}

bootstrap(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  console.error(`\n✗ bootstrap 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

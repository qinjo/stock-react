import { createHash } from "node:crypto";

/**
 * 分析结果缓存（内存 + TTL）。
 *
 * 键设计（实测教训）：**不用提示词全文哈希**。
 *
 * ai-hedge-fund 的 PromptCache 以 `sha256(system+user)` 为键，因为它的输入是
 * 季度财报快照（期内稳定）。本项目输入含**实时行情**：盘中价格逐秒变化，
 * 实测两次构建的提示词有 12/95 行不同（价格 1253.92→1253.73），
 * 全文哈希会导致缓存永不命中、每次查询都真实调 LLM（每次都在花钱）。
 *
 * 故键取「股票 + 交易日」（`sha256(code + dataDate)`）：
 * - 同一交易日内 TTL 内复用（盘中价格微幅波动不改变分析结论）
 * - 跨交易日自动失效（dataDate 变化即换键）
 * 这保留了「同票重复查询零 LLM 调用」的规格意图，又不返回隔日结论。
 *
 * 注意：本缓存**不缓存 abstain**（失败结果），否则一次偶发失败会
 * 在 TTL 内持续返回失败。
 */

export type CacheEntry<T> = { value: T; expiresAt: number };

export type CacheStats = {
  hits: number;
  misses: number;
  size: number;
};

export class PromptCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly maxEntries: number = 200,
    private readonly now: () => number = Date.now,
  ) {}

  /** 提示词哈希：system 与 user 以分隔符拼接，避免边界歧义。 */
  static keyFor(system: string, user: string): string {
    return createHash("sha256").update(`${system}\u0000${user}`).digest("hex");
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    // 简单的容量保护：超限时淘汰最早插入的一项（Map 保持插入序）
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }
}

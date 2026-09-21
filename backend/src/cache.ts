import { createHash } from "node:crypto";

/**
 * 分析结果缓存（内存 + TTL）。
 *
 * 键为**提示词哈希**（ai-hedge-fund 的 PromptCache 思路）：
 * `sha256(system + user)` —— 只要喂给模型的内容逐字相同就直接复用，
 * 数据没变化时零 LLM 调用。比按股票代码做键更精确：股价/指标一变，
 * 哈希即变，天然不会返回过期结论。
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

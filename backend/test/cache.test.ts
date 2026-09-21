import { describe, expect, it, vi } from "vitest";
import { PromptCache } from "../src/cache.js";

describe("PromptCache", () => {
  it("未过期的键可命中，未写入的键不命中", () => {
    const cache = new PromptCache<string>(1000);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "值");
    expect(cache.get("a")).toBe("值");
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("TTL 到期后失效（不返回过期结论）", () => {
    let now = 1_000;
    const cache = new PromptCache<string>(500, 10, () => now);

    cache.set("k", "旧值");
    now += 499;
    expect(cache.get("k")).toBe("旧值");
    now += 2; // 越过 500ms TTL
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().size).toBe(0); // 过期项被清理
  });

  it("超出容量时淘汰最早插入的项（Map 插入序）", () => {
    const cache = new PromptCache<number>(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("keyFor 对相同提示词稳定、对任一变化敏感，且不受拼接歧义影响", () => {
    const k1 = PromptCache.keyFor("系统", "用户");
    expect(PromptCache.keyFor("系统", "用户")).toBe(k1);

    expect(PromptCache.keyFor("系统", "用户2")).not.toBe(k1);
    expect(PromptCache.keyFor("系统2", "用户")).not.toBe(k1);
    // 分隔符防止 ("ab","c") 与 ("a","bc") 撞键
    expect(PromptCache.keyFor("ab", "c")).not.toBe(PromptCache.keyFor("a", "bc"));
  });

  it("clear 清空全部条目", () => {
    const cache = new PromptCache<string>(1000);
    cache.set("a", "1");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it("默认 now 使用系统时间（不注入也能工作）", () => {
    vi.useFakeTimers();
    try {
      const cache = new PromptCache<string>(1000);
      cache.set("k", "v");
      expect(cache.get("k")).toBe("v");
      vi.advanceTimersByTime(1001);
      expect(cache.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  rateLimitFromEnv,
  registerRateLimit,
} from "../src/rate-limit.js";
import { buildApp } from "../src/app.js";

describe("rateLimitFromEnv", () => {
  it("默认关闭（本地开发不受影响）", () => {
    expect(rateLimitFromEnv({})).toEqual(DEFAULT_RATE_LIMIT);
  });

  it("仅在显式 true 时启用", () => {
    expect(rateLimitFromEnv({ RATE_LIMIT_ENABLED: "true" }).enabled).toBe(true);
    expect(rateLimitFromEnv({ RATE_LIMIT_ENABLED: "1" }).enabled).toBe(false);
    expect(rateLimitFromEnv({ RATE_LIMIT_ENABLED: "false" }).enabled).toBe(false);
  });

  it("非法数值回退到默认值", () => {
    const cfg = rateLimitFromEnv({ RATE_LIMIT_MAX: "0", RATE_LIMIT_WINDOW_MS: "abc" });
    expect(cfg.max).toBe(DEFAULT_RATE_LIMIT.max);
    expect(cfg.windowMs).toBe(DEFAULT_RATE_LIMIT.windowMs);
  });
});

describe("registerRateLimit", () => {
  it("未启用时不拦截任何请求", async () => {
    const app = Fastify();
    registerRateLimit(app, { enabled: false, max: 1, windowMs: 1000 });
    app.get("/ping", async () => ({ ok: true }));

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("启用后超过阈值返回 429 与 Retry-After，形状符合统一错误契约", async () => {
    const app = Fastify();
    registerRateLimit(app, { enabled: true, max: 3, windowMs: 60_000 });
    app.get("/ping", async () => ({ ok: true }));

    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "GET", url: "/ping" });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.json()).toMatchObject({ status: "error", code: "RATE_LIMITED" });
    await app.close();
  });

  it("窗口过期后计数重置", async () => {
    let now = 1_000_000;
    const app = Fastify();
    registerRateLimit(app, { enabled: true, max: 2, windowMs: 1000 }, () => now);
    app.get("/ping", async () => ({ ok: true }));

    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(429);

    now += 1001; // 越过窗口
    expect((await app.inject({ method: "GET", url: "/ping" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("app 集成限流", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
  });

  it("通过 options 启用后，真实应用同样受限", async () => {
    const app = buildApp({ rateLimit: { enabled: true, max: 2, windowMs: 60_000 } });

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

    const blocked = await app.inject({ method: "GET", url: "/api/health" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("RATE_LIMITED");
    await app.close();
  });
});

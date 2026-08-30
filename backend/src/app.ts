import Fastify, { type FastifyInstance } from "fastify";

/**
 * 构建应用实例（不含监听）。
 * 独立成函数是为了测试：测试用 `app.inject()` 发请求，不占端口、不触网。
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => {
    return {
      status: "ok",
      service: "stock-backend",
      time: new Date().toISOString(),
    };
  });

  return app;
}
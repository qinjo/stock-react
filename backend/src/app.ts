import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ApiError } from "./errors.js";
import { dataRoutes } from "./routes/data.js";

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

  app.register(dataRoutes);

  // 统一错误形状：{ status, code, message }
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.httpStatus).send(err.toBody());
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.status(status).send({
      status: "error",
      code: "SOURCE_UNAVAILABLE",
      message: status >= 500 ? "服务暂时不可用" : err.message,
    });
  });

  return app;
}
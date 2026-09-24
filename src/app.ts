import Fastify from "fastify";
import { openRawDatabase } from "./database.js";
import { AppError } from "./errors.js";
import { registerRoutes } from "./routes.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  const db = openRawDatabase();
  app.addHook("onClose", async () => {
    db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      return reply.status(400).send({ error: { code: "VALIDATION_FAILED", message: "请求格式不合法" } });
    }
    return reply.status(500).send({ error: { code: "INTERNAL", message: "服务内部错误" } });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "路由不存在" } });
  });

  app.get("/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  registerRoutes(app, db);
  return app;
}

import Fastify from "fastify";
import { sql } from "kysely";
import { openDatabase } from "./database.js";
import { registerRoutes } from "./http/routes.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => {
    const database = openDatabase();
    await sql`SELECT 1`.execute(database);
    await database.destroy();
    return { status: "ok" };
  });
  app.register(registerRoutes);
  return app;
}

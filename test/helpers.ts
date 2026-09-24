import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openRawDatabase, withDatabase } from "../src/database.js";

export interface World {
  app: FastifyInstance;
  db: Database.Database;
  dbPath: string;
  request: (options: {
    method: "GET" | "POST" | "PUT";
    url: string;
    body?: unknown;
    user?: string;
  }) => Promise<{ status: number; json: () => any }>;
}

/** 每个用例一个临时库、一个独立连接上下文，并执行全部迁移 */
export async function freshWorld(label = "evidence"): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), `dispute-${label}-`));
  const dbPath = join(dir, "service.sqlite3");

  const db = openRawDatabase(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  for (const file of readdirSync("migrations").filter((n) => n.endsWith(".sql")).sort()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join("migrations", file), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // 领域层在该异步上下文中固定使用本世界的连接，测试可并行
  const app = buildApp();
  await app.ready();
  const world: World = {
    app,
    db,
    dbPath,
    request: (options) =>
      withDatabase(db, () =>
        app
          .inject({
            method: options.method,
            url: options.url,
            payload: options.body as never,
            headers: options.user ? { "x-user-id": options.user } : undefined,
          })
          .then((res) => ({ status: res.statusCode, json: () => res.json() })),
      ),
  };
  return world;
}

export function month(n: number): string {
  return `2026-${String(n).padStart(2, "0")}`;
}

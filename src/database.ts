import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

interface DatabaseSchema {
  service_state: {
    key: string;
    value: string;
    updated_at: string;
  };
}

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "data/consumer_disputes.sqlite3";
}

export function openRawDatabase(path = databasePath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  return database;
}

// 进程内复用同一路径的连接，避免每个请求新建 WAL 连接
let cachedRaw: { path: string; database: Database.Database } | undefined;
// 测试（或未来的多租户）可在异步上下文中指定独立连接，互不干扰
const databaseContext = new AsyncLocalStorage<Database.Database>();

export function withDatabase<T>(database: Database.Database, fn: () => T): T {
  return databaseContext.run(database, fn);
}

export function rawDb(): Database.Database {
  const contextual = databaseContext.getStore();
  if (contextual) return contextual;
  const path = databasePath();
  if (!cachedRaw || cachedRaw.path !== path) {
    cachedRaw?.database.close();
    cachedRaw = { path, database: openRawDatabase(path) };
  }
  return cachedRaw.database;
}

export function openDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: openRawDatabase() }),
  });
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { openRawDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrations.js";

export interface TestContext {
  app: FastifyInstance;
  cleanup: () => Promise<void>;
}

export async function setupApp(): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), "dispute-evidence-"));
  process.env.DATABASE_PATH = join(dir, "test.sqlite3");
  process.env.MIN_CELL_SIZE = "2";
  const migrateDb = openRawDatabase();
  runMigrations(migrateDb);
  migrateDb.close();
  const app = buildApp();
  return {
    app,
    cleanup: async () => {
      await app.close();
      delete process.env.DATABASE_PATH;
      delete process.env.MIN_CELL_SIZE;
    },
  };
}

export async function seedSource(app: FastifyInstance, sourceKey = "src-a") {
  const response = await app.inject({
    method: "POST",
    url: "/sources",
    payload: { source_key: sourceKey, display_name: `来源${sourceKey}` },
  });
  if (response.statusCode !== 200) throw new Error(`登记来源失败: ${response.body}`);
}

export async function seedTaxonomy(app: FastifyInstance, versionKey = "tax-v1") {
  const response = await app.inject({
    method: "POST",
    url: "/taxonomy/versions",
    payload: {
      version_key: versionKey,
      categories: [
        { category_key: "REFUND", label: "退款问题", keywords: ["退款"], valid_from: "2026-01" },
        { category_key: "LOGISTICS", label: "物流问题", keywords: ["物流"], valid_from: "2026-01" },
      ],
    },
  });
  if (response.statusCode !== 201) throw new Error(`创建词典失败: ${response.body}`);
}

export async function importBatchOnce(
  app: FastifyInstance,
  sourceKey: string,
  batchKey: string,
  watermark: string,
  events: Array<Record<string, string>>,
  withdrawals: Array<Record<string, string>> = [],
) {
  const response = await app.inject({
    method: "POST",
    url: `/sources/${sourceKey}/batches`,
    payload: { batch_key: batchKey, watermark, events, withdrawals },
  });
  if (response.statusCode >= 300) throw new Error(`导入批次失败: ${response.body}`);
  return response.json();
}

import type Database from "better-sqlite3";
import { rawDb } from "../database.js";

export function registerSource(sourceKey: string, displayName: string, db: Database.Database = rawDb()): void {
  db.prepare(
    `INSERT INTO source_registry(source_key, display_name) VALUES (?,?)
     ON CONFLICT(source_key) DO UPDATE SET display_name = excluded.display_name`,
  ).run(sourceKey, displayName);
}

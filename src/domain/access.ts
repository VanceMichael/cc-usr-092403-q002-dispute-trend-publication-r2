import type Database from "better-sqlite3";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";

export type Role = "publisher" | "analyst" | "viewer";
export type ScopeDimension = "merchant" | "category" | "all";

export function createUser(userId: string, displayName: string, role: Role, db: Database.Database = rawDb()): void {
  db.prepare(
    `INSERT INTO users(user_id, display_name, role) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role`,
  ).run(userId, displayName, role);
}

export function grantScope(
  userId: string,
  dimension: ScopeDimension,
  scopeValue: string,
  db: Database.Database = rawDb(),
): void {
  const user = db.prepare("SELECT role FROM users WHERE user_id = ?").get(userId);
  if (!user) throw new DomainError("INVALID_PAYLOAD", `用户不存在: ${userId}`);
  db.prepare("INSERT OR IGNORE INTO viewer_scopes(user_id, dimension, scope_value) VALUES (?,?,?)").run(
    userId,
    dimension,
    dimension === "all" ? "*" : scopeValue,
  );
}

export interface Principal {
  userId: string;
  role: Role;
}

export function principal(userId: string | undefined, db: Database.Database = rawDb()): Principal {
  if (!userId) throw new DomainError("INVALID_PAYLOAD", "缺少用户标识");
  const row = db.prepare("SELECT user_id AS userId, role FROM users WHERE user_id = ?").get(userId) as
    | Principal
    | undefined;
  if (!row) throw new DomainError("INVALID_PAYLOAD", `用户不存在: ${userId}`);
  return row;
}

/**
 * 查看者只能下钻职责范围内的细分：匹配 merchant 或 category 授权，或持 all 授权。
 * publisher/analyst 角色同样需要显式范围，范围不随角色自动放大。
 */
export function assertDrilldownAllowed(
  userId: string,
  target: { merchantRef?: string; termCode?: string },
  db: Database.Database = rawDb(),
): void {
  principal(userId, db);
  const scopes = db
    .prepare("SELECT dimension, scope_value FROM viewer_scopes WHERE user_id = ?")
    .all(userId) as { dimension: ScopeDimension; scope_value: string }[];
  const allowed = scopes.some((s) => {
    if (s.dimension === "all") return true;
    if (s.dimension === "merchant") return target.merchantRef === s.scope_value;
    if (s.dimension === "category") return target.termCode === s.scope_value;
    return false;
  });
  if (!allowed) {
    throw new DomainError("FORBIDDEN_SCOPE", "超出该查看者职责范围的下钻", {
      userId,
      requested: target,
    });
  }
}

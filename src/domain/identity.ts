import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";

export interface MerchantRef {
  id: number;
  merchantRef: string;
  displayPseudonym: string;
}

function pseudonymFor(alias: string): string {
  return "M-" + createHash("sha256").update(`merchant:${alias}`).digest("hex").slice(0, 10);
}

function getMerchantByRef(db: Database.Database, ref: string): MerchantRef | undefined {
  return db
    .prepare("SELECT id, merchant_ref AS merchantRef, display_pseudonym AS displayPseudonym FROM merchants WHERE merchant_ref = ?")
    .get(ref) as MerchantRef | undefined;
}

function requireMerchant(db: Database.Database, ref: string): MerchantRef {
  const merchant = getMerchantByRef(db, ref);
  if (!merchant) throw new DomainError("MERCHANT_NOT_FOUND", `商家不存在: ${ref}`);
  return merchant;
}

/**
 * 首次见到的别名自动建商，区间 [最早出现日期, ∞)。
 * 人工拆分通过 mapAlias 在指定日期切走区间；complaints 原始行永不被改写。
 */
export function ensureAutoAlias(db: Database.Database, alias: string, atDate: string): MerchantRef {
  const existing = db
    .prepare(
      `SELECT m.id AS id, m.merchant_ref AS merchantRef, m.display_pseudonym AS displayPseudonym
       FROM merchant_aliases a JOIN merchants m ON m.id = a.merchant_id
       WHERE a.alias_value = ? AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?)
       ORDER BY a.created_at DESC LIMIT 1`,
    )
    .get(alias, atDate, atDate) as MerchantRef | undefined;
  if (existing) return existing;

  const autoRef = "auto:" + createHash("sha256").update(`alias:${alias}`).digest("hex").slice(0, 12);
  let merchant = getMerchantByRef(db, autoRef);
  if (!merchant) {
    const info = db
      .prepare("INSERT INTO merchants(merchant_ref, display_pseudonym) VALUES (?,?)")
      .run(autoRef, pseudonymFor(alias));
    merchant = {
      id: Number(info.lastInsertRowid),
      merchantRef: autoRef,
      displayPseudonym: pseudonymFor(alias),
    };
  }
  db.prepare(
    "INSERT INTO merchant_aliases(alias_value, merchant_id, valid_from, decided_by) VALUES (?,?,?,'auto')",
  ).run(alias, merchant.id, atDate);
  return merchant;
}

export function createMerchant(ref: string, displayPseudonym: string, db: Database.Database = rawDb()): MerchantRef {
  if (getMerchantByRef(db, ref)) return requireMerchant(db, ref);
  const info = db.prepare("INSERT INTO merchants(merchant_ref, display_pseudonym) VALUES (?,?)").run(ref, displayPseudonym);
  return { id: Number(info.lastInsertRowid), merchantRef: ref, displayPseudonym };
}

function assertNoOverlap(db: Database.Database, alias: string, from: string, to: string | null, exceptId = 0) {
  const rows = db
    .prepare("SELECT id, valid_from, valid_to FROM merchant_aliases WHERE alias_value = ? AND id <> ?")
    .all(alias, exceptId) as { id: number; valid_from: string; valid_to: string | null }[];
  for (const row of rows) {
    const rowTo = row.valid_to ?? "9999-12-31";
    const newTo = to ?? "9999-12-31";
    if (row.valid_from < newTo && from < rowTo) {
      throw new DomainError("ALIAS_RANGE_OVERLAP", `别名「${alias}」有效区间与既有区间重叠`, {
        existing: { validFrom: row.valid_from, validTo: row.valid_to },
      });
    }
  }
}

export interface MapAliasInput {
  alias: string;
  targetMerchantRef: string;
  validFrom: string;
  validTo?: string | null;
  decidedBy: string;
  note?: string;
  /** 拆分：自动关闭该别名当前开放（且起点更早）的 auto 区间 */
  splitFromOpenAuto?: boolean;
}

/**
 * 人工映射别名到指定商家（拆分即把别名在某日期之后指向新商家）。
 * 原始投诉与来报别名均不变，仅追加区间与决策记录。
 */
export function mapAlias(input: MapAliasInput, db: Database.Database = rawDb()): void {
  const target = requireMerchant(db, input.targetMerchantRef);
  const to = input.validTo ?? null;
  if (to && to <= input.validFrom) throw new DomainError("INVALID_PAYLOAD", "validTo 必须晚于 validFrom");

  const tx = db.transaction(() => {
    if (input.splitFromOpenAuto) {
      // 处理与新区间冲突的开放 auto 区间：
      // - auto 起点早于人工起点 → 在人工起点处切分（保留 auto 历史段）
      // - auto 起点不早于人工起点 → 人工决策完全覆盖，删除该 auto 区间（从未生效）
      const openAutos = db
        .prepare(
          `SELECT id, valid_from FROM merchant_aliases
           WHERE alias_value = ? AND valid_to IS NULL AND decided_by = 'auto'`,
        )
        .all(input.alias) as { id: number; valid_from: string }[];
      for (const auto of openAutos) {
        if (auto.valid_from < input.validFrom) {
          db.prepare("UPDATE merchant_aliases SET valid_to = ? WHERE id = ?").run(input.validFrom, auto.id);
        } else {
          db.prepare("DELETE FROM merchant_aliases WHERE id = ?").run(auto.id);
        }
      }
    }
    assertNoOverlap(db, input.alias, input.validFrom, to);
    db.prepare(
      "INSERT INTO merchant_aliases(alias_value, merchant_id, valid_from, valid_to, decided_by) VALUES (?,?,?,?,?)",
    ).run(input.alias, target.id, input.validFrom, to, `manual:${input.decidedBy}`);
    db.prepare(
      `INSERT INTO identity_decisions(action, alias_value, target_merchant_ref, valid_from, valid_to, decided_by, note)
       VALUES ('map', ?, ?, ?, ?, ?, ?)`,
    ).run(input.alias, target.merchantRef, input.validFrom, to, `manual:${input.decidedBy}`, input.note ?? null);
  });
  tx.immediate();
}

function mergeTargetAt(
  db: Database.Database,
  sourceId: number,
  atDate: string,
  seen: Set<number>,
): number {
  if (seen.has(sourceId)) throw new DomainError("MERGE_CYCLE", "商家合并链存在环路");
  seen.add(sourceId);
  const row = db
    .prepare(
      `SELECT target_merchant_id AS tid FROM merchant_merges
       WHERE source_merchant_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceId, atDate, atDate) as { tid: number } | undefined;
  if (!row) return sourceId;
  return mergeTargetAt(db, row.tid, atDate, seen);
}

/** 解析某日期下别名对应的最终商家（别名区间 + 合并链） */
export function resolveMerchant(
  alias: string,
  atDate: string,
  db: Database.Database = rawDb(),
): MerchantRef | undefined {
  const aliasRow = db
    .prepare(
      `SELECT merchant_id AS id FROM merchant_aliases
       WHERE alias_value = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY CASE WHEN decided_by LIKE 'manual:%' THEN 1 ELSE 0 END DESC, created_at DESC
       LIMIT 1`,
    )
    .get(alias, atDate, atDate) as { id: number } | undefined;
  if (!aliasRow) return undefined;
  const canonicalId = mergeTargetAt(db, aliasRow.id, atDate, new Set());
  return db
    .prepare(
      "SELECT id, merchant_ref AS merchantRef, display_pseudonym AS displayPseudonym FROM merchants WHERE id = ?",
    )
    .get(canonicalId) as MerchantRef;
}

function assertNoMergeOverlap(db: Database.Database, sourceId: number, from: string, to: string | null) {
  const rows = db
    .prepare(
      "SELECT valid_from, valid_to FROM merchant_merges WHERE source_merchant_id = ? AND valid_to IS NULL",
    )
    .all(sourceId) as { valid_from: string }[];
  for (const row of rows) {
    if (row.valid_from < (to ?? "9999-12-31") && from < "9999-12-31") {
      throw new DomainError("MERGE_RANGE_OVERLAP", "该商家存在尚未关闭的合并区间，请先纠正再合并", {
        openFrom: row.valid_from,
      });
    }
  }
}

export interface MergeInput {
  sourceMerchantRef: string;
  targetMerchantRef: string;
  validFrom: string;
  validTo?: string | null;
  decidedBy: string;
  note?: string;
}

/** 人工确认两个商家合并（区间生效），附决策审计 */
export function mergeMerchants(input: MergeInput, db: Database.Database = rawDb()): void {
  const source = requireMerchant(db, input.sourceMerchantRef);
  const target = requireMerchant(db, input.targetMerchantRef);
  if (source.id === target.id) throw new DomainError("INVALID_PAYLOAD", "不能合并商家自身");
  const to = input.validTo ?? null;
  if (to && to <= input.validFrom) throw new DomainError("INVALID_PAYLOAD", "validTo 必须晚于 validFrom");

  const tx = db.transaction(() => {
    assertNoMergeOverlap(db, source.id, input.validFrom, to);
    // 防止在生效日形成环
    if (mergeTargetAt(db, target.id, input.validFrom, new Set()) === source.id) {
      throw new DomainError("MERGE_CYCLE", "合并将形成环路");
    }
    const decisionInfo = db
      .prepare(
        `INSERT INTO identity_decisions(action, source_merchant_ref, target_merchant_ref, valid_from, valid_to, decided_by, note)
         VALUES ('merge', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.merchantRef,
        target.merchantRef,
        input.validFrom,
        to,
        `manual:${input.decidedBy}`,
        input.note ?? null,
      );
    db.prepare(
      "INSERT INTO merchant_merges(source_merchant_id, target_merchant_id, valid_from, valid_to, decided_by, decision_id) VALUES (?,?,?,?,?,?)",
    ).run(source.id, target.id, input.validFrom, to, `manual:${input.decidedBy}`, Number(decisionInfo.lastInsertRowid));
  });
  tx.immediate();
}

export interface CorrectMergeInput {
  sourceMerchantRef: string;
  newTargetMerchantRef: string;
  validFrom: string; // 纠正生效日：旧合并区间在此关闭，新区间从此开始
  decidedBy: string;
  note?: string;
}

/**
 * 身份纠正：关闭该商家当前开放的合并区间并追加新区间。
 * 不删除旧区间——历史发布仍按当时的区间解析，新版本据此产生 identity_correction 差异。
 */
export function correctMerge(input: CorrectMergeInput, db: Database.Database = rawDb()): void {
  const source = requireMerchant(db, input.sourceMerchantRef);
  const target = requireMerchant(db, input.newTargetMerchantRef);
  if (source.id === target.id) throw new DomainError("INVALID_PAYLOAD", "纠正目标不能是商家自身");

  const tx = db.transaction(() => {
    const open = db
      .prepare(
        "SELECT id, valid_from, target_merchant_id FROM merchant_merges WHERE source_merchant_id = ? AND valid_to IS NULL",
      )
      .get(source.id) as { id: number; valid_from: string; target_merchant_id: number } | undefined;
    if (!open) throw new DomainError("MERGE_NOT_FOUND", "该商家没有可纠正的开放合并区间");
    if (input.validFrom <= open.valid_from) {
      throw new DomainError("INVALID_PAYLOAD", "纠正生效日必须晚于原合并生效日");
    }
    db.prepare("UPDATE merchant_merges SET valid_to = ? WHERE id = ?").run(input.validFrom, open.id);
    if (mergeTargetAt(db, target.id, input.validFrom, new Set()) === source.id) {
      throw new DomainError("MERGE_CYCLE", "纠正后的合并将形成环路");
    }
    db.prepare(
      "INSERT INTO merchant_merges(source_merchant_id, target_merchant_id, valid_from, decided_by) VALUES (?,?,?,?)",
    ).run(source.id, target.id, input.validFrom, `manual:${input.decidedBy}`);
    db.prepare(
      `INSERT INTO identity_decisions(action, source_merchant_ref, target_merchant_ref, valid_from, decided_by, note)
       VALUES ('split', ?, ?, ?, ?, ?)`,
    ).run(source.merchantRef, target.merchantRef, input.validFrom, `manual:${input.decidedBy}`, input.note ?? null);
  });
  tx.immediate();
}

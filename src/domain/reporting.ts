import type Database from "better-sqlite3";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";
import { assertDrilldownAllowed, principal } from "./access.js";

interface PublicationRow {
  id: number;
  version: number;
  taxonomyVersion: string;
  minSampleThreshold: number;
  createdAt: string;
}

function loadPublication(db: Database.Database, month: string, version?: number): PublicationRow {
  const row = version
    ? (db
        .prepare(
          `SELECT id, version, taxonomy_version AS taxonomyVersion, min_sample_threshold AS minSampleThreshold, created_at AS createdAt
           FROM publications WHERE report_month = ? AND version = ?`,
        )
        .get(month, version) as PublicationRow | undefined)
    : (db
        .prepare(
          `SELECT id, version, taxonomy_version AS taxonomyVersion, min_sample_threshold AS minSampleThreshold, created_at AS createdAt
           FROM publications WHERE report_month = ? AND status = 'current'`,
        )
        .get(month) as PublicationRow | undefined);
  if (!row) throw new DomainError("PUBLICATION_NOT_FOUND", `没有可用发布: ${month}${version ? ` v${version}` : ""}`);
  return row;
}

function previousOf(db: Database.Database, month: string, version: number): PublicationRow | undefined {
  return db
    .prepare(
      `SELECT id, version, taxonomy_version AS taxonomyVersion, min_sample_threshold AS minSampleThreshold, created_at AS createdAt
       FROM publications WHERE report_month = ? AND version < ? ORDER BY version DESC LIMIT 1`,
    )
    .get(month, version) as PublicationRow | undefined;
}

export interface CellView {
  merchantRef: string;
  merchantPseudonym: string;
  termCode: string;
  /** 抑制单元格不返回真实计数 */
  count: number | null;
  suppressed: boolean;
}

export interface DiffView {
  fromVersion: number;
  toVersion: number;
  changedComplaints: { complaintId: number; reason: string; includedBefore: boolean; includedAfter: boolean }[];
  countDeltas: { merchantRef: string; termCode: string; before: number | null; after: number | null; delta: number | null }[];
}

export interface MonthlyReport {
  month: string;
  version: number;
  taxonomyVersion: string;
  publishedAt: string;
  lockedWatermarks: { sourceKey: string; watermark: number }[];
  cells: CellView[];
  totals: { included: number; suppressedCells: number; visibleComplaints: number };
  diff: DiffView | null;
  pendingCandidates: { candidateId: number | null; complaintId: number; proposedTermCode: string | null }[];
}

/** 月报页面接口：当期数字 + 与上一发布版的差异来源 + 未决候选 */
export function monthlyReport(month: string, version?: number, db: Database.Database = rawDb()): MonthlyReport {
  const pub = loadPublication(db, month, version);
  const prev = previousOf(db, month, pub.version);

  const cells = db
    .prepare(
      `SELECT m.merchant_ref AS merchantRef, m.display_pseudonym AS merchantPseudonym,
              pc.term_code AS termCode, pc.complaint_count AS count, pc.suppressed AS suppressed
       FROM publication_cells pc JOIN merchants m ON m.id = pc.merchant_id
       WHERE pc.publication_id = ? ORDER BY m.merchant_ref, pc.term_code`,
    )
    .all(pub.id) as (Omit<CellView, "suppressed"> & { suppressed: number })[];

  const cellViews: CellView[] = cells.map((c) => ({
    merchantRef: c.merchantRef,
    merchantPseudonym: c.merchantPseudonym,
    termCode: c.termCode,
    // 样本过少的细分结果必须抑制：不向前端给出真实计数
    count: c.suppressed === 1 ? (null as unknown as number) : c.count,
    suppressed: c.suppressed === 1,
  }));

  const totalsRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(included),0) AS included,
         COALESCE(SUM(CASE WHEN included = 0 THEN 1 ELSE 0 END),0) AS excluded
       FROM publication_complaints WHERE publication_id = ?`,
    )
    .get(pub.id) as { included: number; excluded: number };

  let diff: DiffView | null = null;
  if (prev) {
    const changed = db
      .prepare(
        `SELECT pc.complaint_id AS cid, pc.change_reason AS reason,
                COALESCE(old.included, 0) AS beforeIncluded, pc.included AS afterIncluded
         FROM publication_complaints pc
         LEFT JOIN publication_complaints old ON old.publication_id = ? AND old.complaint_id = pc.complaint_id
         WHERE pc.publication_id = ? AND pc.change_reason IS NOT NULL
         ORDER BY pc.complaint_id`,
      )
      .all(prev.id, pub.id) as { cid: number; reason: string; beforeIncluded: number; afterIncluded: number }[];

    // SQLite 无 FULL OUTER JOIN：两侧单元格并集后按单元格聚合差异；
    // 任一侧被抑制的单元格不给出真实计数，防止从差值反推小样本
    const deltas = db
      .prepare(
        `WITH cells AS (
           SELECT merchant_id AS mid, term_code AS term, complaint_count AS n, suppressed AS sup, 0 AS side
             FROM publication_cells WHERE publication_id = ?
           UNION ALL
           SELECT merchant_id AS mid, term_code AS term, complaint_count AS n, suppressed AS sup, 1 AS side
             FROM publication_cells WHERE publication_id = ?
         ), paired AS (
           SELECT mid, term,
                  SUM(CASE WHEN side = 0 THEN n ELSE 0 END) AS beforeCount,
                  SUM(CASE WHEN side = 1 THEN n ELSE 0 END) AS afterCount,
                  MAX(sup) AS suppressed
           FROM cells GROUP BY mid, term
         )
         SELECT m.merchant_ref AS merchantRef, p.term AS termCode, p.beforeCount, p.afterCount, p.suppressed
         FROM paired p JOIN merchants m ON m.id = p.mid
         WHERE p.beforeCount <> p.afterCount
         ORDER BY m.merchant_ref, p.term`,
      )
      .all(prev.id, pub.id) as {
      merchantRef: string;
      termCode: string;
      beforeCount: number;
      afterCount: number;
      suppressed: number;
    }[];

    diff = {
      fromVersion: prev.version,
      toVersion: pub.version,
      changedComplaints: changed.map((c) => ({
        complaintId: c.cid,
        reason: c.reason,
        includedBefore: c.beforeIncluded === 1,
        includedAfter: c.afterIncluded === 1,
      })),
      countDeltas: deltas.map((d) =>
        d.suppressed === 1
          ? { merchantRef: d.merchantRef, termCode: d.termCode, before: null, after: null, delta: null }
          : {
              merchantRef: d.merchantRef,
              termCode: d.termCode,
              before: d.beforeCount,
              after: d.afterCount,
              delta: d.afterCount - d.beforeCount,
            },
      ),
    };
  }

  // 未决候选：锁定水位内、已接收但尚未人工确认的投诉——
  // 既包括自动生成的 pending 候选，也包括归类尚未覆盖（无候选行）的迟到投诉
  const pending = db
    .prepare(
      `SELECT cc.id AS candidateId, c.id AS complaintId, cc.proposed_term_code AS proposedTermCode
       FROM complaints c
       JOIN source_batches b ON b.id = c.registered_batch_id
       JOIN publication_source_watermarks w
         ON w.publication_id = ? AND w.source_key = b.source_key AND b.watermark <= w.watermark
       LEFT JOIN classification_candidates cc
         ON cc.complaint_id = c.id AND cc.taxonomy_version = ?
       WHERE c.complaint_month = ? AND (cc.id IS NULL OR cc.state = 'pending')
       ORDER BY c.id`,
    )
    .all(pub.id, pub.taxonomyVersion, month) as {
    candidateId: number | null;
    complaintId: number;
    proposedTermCode: string | null;
  }[];

  const watermarks = db
    .prepare("SELECT source_key AS sourceKey, watermark FROM publication_source_watermarks WHERE publication_id = ?")
    .all(pub.id) as { sourceKey: string; watermark: number }[];

  return {
    month,
    version: pub.version,
    taxonomyVersion: pub.taxonomyVersion,
    publishedAt: pub.createdAt,
    lockedWatermarks: watermarks,
    cells: cellViews,
    totals: {
      included: totalsRow.included,
      suppressedCells: cellViews.filter((c) => c.suppressed).length,
      visibleComplaints: cellViews.reduce((sum, c) => sum + (c.suppressed ? 0 : (c.count ?? 0)), 0),
    },
    diff,
    pendingCandidates: pending,
  };
}

const SENSITIVE_KEY_RE = /(姓名|手机|电话|身份证|证件|邮箱|email|phone|mobile|id_?card|real_?name|address|地址|bank|卡号)/i;

/** 下钻只暴露去标识化事实：剔除任何疑似直接标识符 */
export function redactFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (SENSITIVE_KEY_RE.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

export interface EvidenceRow {
  complaintId: number;
  pseudonym: string;
  eventTime: string;
  facts: Record<string, unknown>;
  termCode: string;
}

/**
 * 下钻到去标识化证据：
 * - 校验查看者职责范围（商家/分类）
 * - 抑制单元格不提供下钻（样本过少不暴露成员）
 * - 只返回假名与 facts 中的去标识化字段
 */
export function drilldown(
  userId: string,
  month: string,
  target: { merchantRef?: string; termCode?: string; version?: number },
  db: Database.Database = rawDb(),
): EvidenceRow[] {
  principal(userId, db);
  assertDrilldownAllowed(userId, target, db);
  const pub = loadPublication(db, month, target.version);

  const where: string[] = ["pc.publication_id = ?", "pc.included = 1"];
  const params: unknown[] = [pub.id];
  if (target.merchantRef) {
    where.push("m.merchant_ref = ?");
    params.push(target.merchantRef);
  }
  if (target.termCode) {
    where.push("pc.resolved_term_code = ?");
    params.push(target.termCode);
  }

  const rows = db
    .prepare(
      `SELECT pc.resolved_merchant_id AS mid, pc.resolved_term_code AS term, c.id AS cid
       FROM publication_complaints pc
       JOIN merchants m ON m.id = pc.resolved_merchant_id
       JOIN complaints c ON c.id = pc.complaint_id
       WHERE ${where.join(" AND ")}
       ORDER BY c.id`,
    )
    .all(...params) as { mid: number; term: string; cid: number }[];

  // 被抑制单元格的成员直接从证据中剔除：调用方无法通过下钻反推小样本
  const visibleRows = rows.filter((row) => {
    const cell = db
      .prepare(
        "SELECT suppressed FROM publication_cells WHERE publication_id = ? AND merchant_id = ? AND term_code = ?",
      )
      .get(pub.id, row.mid, row.term) as { suppressed: number } | undefined;
    return cell && cell.suppressed === 0;
  });

  return visibleRows.map((row) => {
    const c = db
      .prepare("SELECT pseudonym, event_time, facts_json FROM complaints WHERE id = ?")
      .get(row.cid) as { pseudonym: string; event_time: string; facts_json: string };
    return {
      complaintId: row.cid,
      pseudonym: c.pseudonym,
      eventTime: c.event_time,
      facts: redactFacts(JSON.parse(c.facts_json) as Record<string, unknown>),
      termCode: row.term,
    };
  });
}

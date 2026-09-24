import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";
import { resolveMerchant } from "./identity.js";

export interface ExclusionInput {
  complaintId: number;
  reason: string;
}

export interface PublishInput {
  reportMonth: string;
  taxonomyVersion: string;
  publishedBy: string;
  minSampleThreshold: number;
  clientToken?: string | null;
  /** 人工排除：complaintId -> 理由码；撤回由系统自动加入 */
  exclusions?: ExclusionInput[];
  /** 锁定的排除理由说明（口径文字） */
  exclusionRationale?: Record<string, string>;
}

export type ChangeReason =
  | "late_arrival"
  | "withdrawal"
  | "identity_correction"
  | "classification_change"
  | "exclusion_change";

interface ResolvedMember {
  complaintId: number;
  sourceKey: string;
  merchantId: number;
  termCode: string | null; // 仅人工确认后非空
  candidateState: string | null;
  included: boolean;
  exclusionReason: string | null;
}

function assertCanPublish(db: Database.Database, input: PublishInput) {
  if (!/^\d{4}-\d{2}$/.test(input.reportMonth))
    throw new DomainError("INVALID_PAYLOAD", "reportMonth 必须为 YYYY-MM");
  const taxonomy = db.prepare("SELECT 1 FROM taxonomy_versions WHERE version = ?").get(input.taxonomyVersion);
  if (!taxonomy) throw new DomainError("TAXONOMY_VERSION_NOT_FOUND", `分类版本不存在: ${input.taxonomyVersion}`);
  if (!Number.isInteger(input.minSampleThreshold) || input.minSampleThreshold < 0)
    throw new DomainError("INVALID_PAYLOAD", "minSampleThreshold 必须为非负整数");
  const user = db.prepare("SELECT role FROM users WHERE user_id = ?").get(input.publishedBy);
  if (!user) throw new DomainError("INVALID_PAYLOAD", `用户不存在: ${input.publishedBy}`);
  if ((user as { role: string }).role !== "publisher")
    throw new DomainError("FORBIDDEN_SCOPE", "仅发布人可以锁定发布", { userId: input.publishedBy });
}

/** 锁定时刻各来源的水位：发布只统计水位及以下已接收批次 */
function lockedWatermarks(db: Database.Database): { sourceKey: string; watermark: number; batchId: number }[] {
  return db
    .prepare(
      `SELECT b.source_key AS sourceKey, b.watermark AS watermark, b.id AS batchId
       FROM source_batches b
       JOIN (SELECT source_key, MAX(watermark) AS wm FROM source_batches GROUP BY source_key) m
         ON m.source_key = b.source_key AND m.wm = b.watermark`,
    )
    .all() as { sourceKey: string; watermark: number; batchId: number }[];
}

function resolveMembers(
  db: Database.Database,
  month: string,
  watermarks: { sourceKey: string; watermark: number }[],
  taxonomyVersion: string,
  manualExclusions: Map<number, string>,
): ResolvedMember[] {
  const wmBySource = new Map(watermarks.map((w) => [w.sourceKey, w.watermark]));
  const complaints = db
    .prepare(
      `SELECT c.id AS id, c.source_key AS sourceKey, c.event_time AS eventTime,
              c.merchant_alias_raw AS alias, b.watermark AS watermark
       FROM complaints c JOIN source_batches b ON b.id = c.registered_batch_id
       WHERE c.complaint_month = ?
       ORDER BY c.id`,
    )
    .all(month) as { id: number; sourceKey: string; eventTime: string; alias: string; watermark: number }[];

  const members: ResolvedMember[] = [];
  for (const c of complaints) {
    const lockedWm = wmBySource.get(c.sourceKey);
    if (lockedWm === undefined || c.watermark > lockedWm) continue; // 锁定水位之后的来报不属于本版

    // 撤回事件也必须在锁定水位及以下，防止未来批次泄漏进已锁定快照
    const withdrawn = db
      .prepare(
        `SELECT 1 FROM complaint_events e JOIN source_batches b ON b.id = e.batch_id
         WHERE e.complaint_id = ? AND e.event_type = 'withdrawn' AND b.watermark <= ?`,
      )
      .get(c.id, lockedWm);
    const candidate = db
      .prepare(
        `SELECT state, confirmed_term_code AS confirmed
         FROM classification_candidates WHERE complaint_id = ? AND taxonomy_version = ?`,
      )
      .get(c.id, taxonomyVersion) as { state: string; confirmed: string | null } | undefined;

    const merchant = resolveMerchant(c.alias, c.eventTime, db);
    if (!merchant) throw new DomainError("MERCHANT_NOT_FOUND", `投诉 ${c.id} 的商家身份无法解析`);

    let included = true;
    let exclusionReason: string | null = null;
    if (withdrawn) {
      included = false;
      exclusionReason = "withdrawn";
    } else if (manualExclusions.has(c.id)) {
      included = false;
      exclusionReason = manualExclusions.get(c.id)!;
    } else if (!candidate || candidate.state !== "confirmed" || !candidate.confirmed) {
      // 自动建议与待决候选都不进入正式数字
      included = false;
      exclusionReason = "unclassified";
    }

    members.push({
      complaintId: c.id,
      sourceKey: c.sourceKey,
      merchantId: merchant.id,
      termCode: candidate?.state === "confirmed" ? candidate.confirmed : null,
      candidateState: candidate?.state ?? null,
      included,
      exclusionReason,
    });
  }
  return members;
}

function fingerprintOf(
  watermarks: { sourceKey: string; watermark: number }[],
  taxonomyVersion: string,
  members: ResolvedMember[],
  minSampleThreshold: number,
): string {
  const h = createHash("sha256");
  h.update(taxonomyVersion);
  h.update(`threshold=${minSampleThreshold};`);
  for (const w of [...watermarks].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)))
    h.update(`${w.sourceKey}=${w.watermark};`);
  for (const m of members)
    h.update(`${m.complaintId}:${m.included ? 1 : 0}:${m.exclusionReason ?? ""}:${m.merchantId}:${m.termCode ?? ""};`);
  return h.digest("hex");
}

export interface PublishResult {
  publicationId: number;
  version: number;
  duplicated: boolean;
}

export function publishMonth(input: PublishInput, db: Database.Database = rawDb()): PublishResult {
  assertCanPublish(db, input);
  const manualExclusions = new Map<number, string>((input.exclusions ?? []).map((e) => [e.complaintId, e.reason]));

  const tx = db.transaction((): PublishResult => {
    // clientToken：同一发布请求的重复提交直接回放
    if (input.clientToken) {
      const prior = db
        .prepare("SELECT id, version FROM publications WHERE client_token = ? AND status = 'current'")
        .get(input.clientToken) as { id: number; version: number } | undefined;
      if (prior) return { publicationId: prior.id, version: prior.version, duplicated: true };
    }

    const watermarks = lockedWatermarks(db);
    for (const e of input.exclusions ?? []) {
      const c = db.prepare("SELECT complaint_month AS m FROM complaints WHERE id = ?").get(e.complaintId) as
        | { m: string }
        | undefined;
      if (!c) throw new DomainError("INVALID_PAYLOAD", `排除的投诉不存在: ${e.complaintId}`);
      if (c.m !== input.reportMonth)
        throw new DomainError("INVALID_PAYLOAD", `投诉 ${e.complaintId} 不属于 ${input.reportMonth}`);
    }

    const members = resolveMembers(db, input.reportMonth, watermarks, input.taxonomyVersion, manualExclusions);
    const fingerprint = fingerprintOf(watermarks, input.taxonomyVersion, members, input.minSampleThreshold);

    const current = db
      .prepare("SELECT id, version, fingerprint FROM publications WHERE report_month = ? AND status = 'current'")
      .get(input.reportMonth) as { id: number; version: number; fingerprint: string } | undefined;
    if (current && current.fingerprint === fingerprint) {
      // 口径与事实均无变化：重复发布不产生新版本、不多计
      return { publicationId: current.id, version: current.version, duplicated: true };
    }

    interface PrevRow {
      cid: number;
      mid: number;
      term: string;
      included: number;
      reason: string | null;
    }
    const prevRows: PrevRow[] = current
      ? (db
          .prepare(
            `SELECT complaint_id AS cid, resolved_merchant_id AS mid, resolved_term_code AS term,
                    included, exclusion_reason AS reason
             FROM publication_complaints WHERE publication_id = ?`,
          )
          .all(current.id) as PrevRow[])
      : [];

    const version = current ? current.version + 1 : 1;
    const pubInfo = db
      .prepare(
        `INSERT INTO publications
           (report_month, version, status, taxonomy_version, min_sample_threshold,
            published_by, client_token, fingerprint, exclusion_rationale_json)
         VALUES (?,?, 'current', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.reportMonth,
        version,
        input.taxonomyVersion,
        input.minSampleThreshold,
        input.publishedBy,
        input.clientToken ?? null,
        fingerprint,
        JSON.stringify(input.exclusionRationale ?? {}),
      );
    const publicationId = Number(pubInfo.lastInsertRowid);

    for (const w of watermarks) {
      db.prepare(
        "INSERT INTO publication_source_watermarks(publication_id, source_key, watermark, batch_id) VALUES (?,?,?,?)",
      ).run(publicationId, w.sourceKey, w.watermark, w.batchId);
    }

    const prevByComplaint = new Map(prevRows.map((r) => [r.cid, r]) ?? []);
    const insertMember = db.prepare(
      `INSERT INTO publication_complaints
         (publication_id, complaint_id, resolved_merchant_id, resolved_term_code, included, exclusion_reason, change_reason)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const insertExclusion = db.prepare(
      "INSERT INTO publication_exclusions(publication_id, complaint_id, reason) VALUES (?,?,?)",
    );

    for (const m of members) {
      const old = current ? prevByComplaint.get(m.complaintId) : undefined;
      let changeReason: ChangeReason | null = null;
      if (current && !old) {
        // 上一版锁定水位之后才到达
        changeReason = "late_arrival";
      } else if (old) {
        if (old.included === 1 && !m.included && m.exclusionReason === "withdrawn") {
          changeReason = "withdrawal";
        } else if (old.reason === "unclassified" && m.included) {
          changeReason = "classification_change";
        } else if (old.included !== (m.included ? 1 : 0) || old.reason !== m.exclusionReason) {
          changeReason = "exclusion_change";
        } else if (old.mid !== m.merchantId) {
          changeReason = "identity_correction";
        } else if (old.term !== (m.termCode ?? "__none__")) {
          changeReason = "classification_change";
        }
      }

      insertMember.run(
        publicationId,
        m.complaintId,
        m.merchantId,
        m.termCode ?? "__none__",
        m.included ? 1 : 0,
        m.exclusionReason,
        changeReason,
      );
      if (!m.included) insertExclusion.run(publicationId, m.complaintId, m.exclusionReason);
    }

    // 细分聚合 + 小样本抑制
    const cells = db
      .prepare(
        `SELECT resolved_merchant_id AS mid, resolved_term_code AS term, COUNT(*) AS n
         FROM publication_complaints
         WHERE publication_id = ? AND included = 1 AND resolved_term_code <> '__none__'
         GROUP BY resolved_merchant_id, resolved_term_code`,
      )
      .all(publicationId) as { mid: number; term: string; n: number }[];
    const insertCell = db.prepare(
      "INSERT INTO publication_cells(publication_id, merchant_id, term_code, complaint_count, suppressed) VALUES (?,?,?,?,?)",
    );
    for (const cell of cells) {
      insertCell.run(publicationId, cell.mid, cell.term, cell.n, cell.n < input.minSampleThreshold ? 1 : 0);
    }

    if (current) {
      // client_token 唯一属于当前版：旧版交出令牌，避免重复发布回放串版
      db.prepare("UPDATE publications SET status = 'superseded', client_token = NULL WHERE id = ?").run(current.id);
    }
    return { publicationId, version, duplicated: false };
  });

  return tx.immediate();
}

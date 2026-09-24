import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { rawDb } from "../database.js";
import { DomainError, type BatchImportRequest, type BatchImportResult } from "./types.js";
import { ensureAutoAlias } from "./identity.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * 按来源业务水位接收一个批次。
 * - (source_key, batch_ref) 唯一：重复投递整批幂等，绝不多计一条投诉
 * - (source_key, watermark) 唯一：水位冲突直接拒绝
 */
export function ingestBatch(input: BatchImportRequest, db: Database.Database = rawDb()): BatchImportResult {
  validate(input);
  const source = db
    .prepare("SELECT source_key FROM source_registry WHERE source_key = ?")
    .get(input.sourceKey) as { source_key: string } | undefined;
  if (!source) throw new DomainError("SOURCE_NOT_REGISTERED", `来源未登记: ${input.sourceKey}`);

  const contentHash =
    input.contentHash ??
    createHash("sha256").update(JSON.stringify({ c: input.complaints ?? [], w: input.withdrawals ?? [] })).digest("hex");

  const tx = db.transaction((req: BatchImportRequest): BatchImportResult => {
    const existing = db
      .prepare("SELECT id, watermark, content_hash FROM source_batches WHERE source_key = ? AND batch_ref = ?")
      .get(req.sourceKey, req.batchRef) as
      | { id: number; watermark: number; content_hash: string | null }
      | undefined;

    if (existing) {
      if (existing.watermark !== req.watermark) {
        throw new DomainError("BATCH_WATERMARK_CONFLICT", "同一业务批次号对应了不同水位", {
          batchRef: req.batchRef,
          storedWatermark: existing.watermark,
          incomingWatermark: req.watermark,
        });
      }
      if (existing.content_hash && existing.content_hash !== contentHash) {
        throw new DomainError("BATCH_CONTENT_CONFLICT", "重复批次的内容指纹不一致", {
          batchRef: req.batchRef,
        });
      }
      // 完全重复投递：直接回放，不插入任何投诉/事件
      return { batchId: existing.id, duplicated: true, importedComplaints: 0, importedWithdrawals: 0 };
    }

    const wmClash = db
      .prepare("SELECT batch_ref FROM source_batches WHERE source_key = ? AND watermark = ?")
      .get(req.sourceKey, req.watermark);
    if (wmClash) {
      throw new DomainError("BATCH_WATERMARK_CONFLICT", "水位已被其他批次占用", {
        watermark: req.watermark,
      });
    }

    const batchInfo = db
      .prepare(
        "INSERT INTO source_batches(source_key, batch_ref, watermark, content_hash) VALUES (?,?,?,?)",
      )
      .run(req.sourceKey, req.batchRef, req.watermark, contentHash);
    const batchId = Number(batchInfo.lastInsertRowid);

    const insertComplaint = db.prepare(`
      INSERT INTO complaints
        (source_key, source_ref, pseudonym, registered_batch_id, event_time, complaint_month,
         merchant_alias_raw, category_raw, facts_json)
      VALUES (@source_key,@source_ref,@pseudonym,@batch_id,@event_time,@complaint_month,
              @merchant_alias_raw,@category_raw,@facts_json)`);
    const insertWithdrawal = db.prepare(`
      INSERT INTO complaint_events(complaint_id, batch_id, source_event_ref, event_type, event_time)
      VALUES (?, ?, ?, 'withdrawn', ?)`);

    let importedComplaints = 0;
    let importedWithdrawals = 0;

    for (const item of req.complaints ?? []) {
      let complaintId: number;
      try {
        const info = insertComplaint.run({
          source_key: req.sourceKey,
          source_ref: item.sourceRef,
          pseudonym: item.pseudonym,
          batch_id: batchId,
          event_time: item.eventTime,
          complaint_month: monthOf(item.eventTime),
          merchant_alias_raw: item.merchantAlias,
          category_raw: item.categoryRaw,
          facts_json: JSON.stringify(item.facts ?? {}),
        });
        complaintId = Number(info.lastInsertRowid);
        importedComplaints++;
      } catch (error) {
        if (isUniqueError(error)) {
          throw new DomainError("BATCH_CONTENT_CONFLICT", "投诉业务号在该来源下已存在于其他批次", {
            sourceRef: item.sourceRef,
          });
        }
        throw error;
      }

      // 首次见到的别名：建立 auto 有效区间（人工映射可在后续切分区间）
      ensureAutoAlias(db, item.merchantAlias, item.eventTime);

      if (item.withdrawn) {
        try {
          insertWithdrawal.run(
            complaintId,
            batchId,
            item.withdrawn.sourceEventRef,
            item.withdrawn.eventTime,
          );
          importedWithdrawals++;
        } catch (error) {
          if (!isUniqueError(error)) throw error;
          // 撤回重复投递：幂等忽略，不多计
        }
      }
    }

    // 迟到撤回：投诉早已入库，撤回随更高水位的批次到达
    for (const withdrawal of req.withdrawals ?? []) {
      const target = db
        .prepare("SELECT id FROM complaints WHERE source_key = ? AND source_ref = ?")
        .get(req.sourceKey, withdrawal.complaintRef) as { id: number } | undefined;
      if (!target) {
        throw new DomainError("BATCH_CONTENT_CONFLICT", "撤回指向的投诉尚未接收", {
          complaintRef: withdrawal.complaintRef,
        });
      }
      try {
        insertWithdrawal.run(target.id, batchId, withdrawal.sourceEventRef, withdrawal.eventTime);
        importedWithdrawals++;
      } catch (error) {
        if (!isUniqueError(error)) throw error; // 撤回重复投递：幂等忽略
      }
    }

    return { batchId, duplicated: false, importedComplaints, importedWithdrawals };
  });

  return tx.immediate(input);
}

function validate(input: BatchImportRequest) {
  const reject = (message: string) =>
    new DomainError("INVALID_PAYLOAD", message, { sourceKey: input.sourceKey });
  if (!input.sourceKey || !input.batchRef) throw reject("缺少 sourceKey/batchRef");
  if (!Number.isInteger(input.watermark) || input.watermark < 0)
    throw reject("watermark 必须为非负整数");
  if (!Array.isArray(input.complaints) && !Array.isArray(input.withdrawals))
    throw reject("complaints/withdrawals 至少提供一个数组");
  for (const item of input.complaints ?? []) {
    if (!item.sourceRef || !item.pseudonym) throw reject("投诉缺少 sourceRef/pseudonym");
    if (!DATE_RE.test(item.eventTime) || Number.isNaN(Date.parse(item.eventTime)))
      throw reject(`eventTime 必须为 YYYY-MM-DD: ${item.sourceRef}`);
    if (!item.merchantAlias || !item.categoryRaw) throw reject(`投诉缺少商家别名/分类: ${item.sourceRef}`);
    if (item.withdrawn && !item.withdrawn.sourceEventRef)
      throw reject(`撤回缺少 sourceEventRef: ${item.sourceRef}`);
  }
  for (const withdrawal of input.withdrawals ?? []) {
    if (!withdrawal.complaintRef || !withdrawal.sourceEventRef)
      throw reject("撤回缺少 complaintRef/sourceEventRef");
    if (!DATE_RE.test(withdrawal.eventTime))
      throw reject(`撤回 eventTime 必须为 YYYY-MM-DD: ${withdrawal.complaintRef}`);
  }
}

function isUniqueError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export interface SourceWatermark {
  sourceKey: string;
  watermark: number;
  batchRef: string;
}

export function currentWatermarks(db: Database.Database = rawDb()): SourceWatermark[] {
  return db
    .prepare(`
      SELECT b.source_key AS source_key, b.watermark AS watermark, b.batch_ref AS batch_ref
      FROM source_batches b
      JOIN (SELECT source_key, MAX(watermark) AS wm FROM source_batches GROUP BY source_key) m
        ON m.source_key = b.source_key AND m.wm = b.watermark`)
    .all() as SourceWatermark[];
}

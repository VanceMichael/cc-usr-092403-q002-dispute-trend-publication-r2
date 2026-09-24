import type Database from "better-sqlite3";
import { fail } from "../errors.js";
import { asObject, checkMonth, optArray, reqString } from "../validate.js";

interface EventInput {
  source_event_id: string;
  cursor: string;
  complaint_month: string;
  merchant_alias: string;
  detail: string;
}

interface WithdrawalInput {
  source_event_id: string;
  cursor: string;
  reason?: string;
}

export interface BatchInput {
  batch_key: string;
  watermark: string;
  events: EventInput[];
  withdrawals: WithdrawalInput[];
}

interface BatchRow {
  batch_id: number;
  source_key: string;
  batch_key: string;
  watermark: string;
  accepted_events: number;
  duplicate_events: number;
  accepted_withdrawals: number;
  duplicate_withdrawals: number;
  received_at: string;
}

function parseEvent(value: unknown, index: number): EventInput {
  const obj = asObject(value, `events[${index}]`);
  return {
    source_event_id: reqString(obj, "source_event_id"),
    cursor: reqString(obj, "cursor"),
    complaint_month: checkMonth(reqString(obj, "complaint_month"), "complaint_month"),
    merchant_alias: reqString(obj, "merchant_alias"),
    detail: reqString(obj, "detail"),
  };
}

function parseWithdrawal(value: unknown, index: number): WithdrawalInput {
  const obj = asObject(value, `withdrawals[${index}]`);
  const reason = obj.reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    fail(400, "VALIDATION_FAILED", `withdrawals[${index}].reason 必须是字符串`);
  }
  return {
    source_event_id: reqString(obj, "source_event_id"),
    cursor: reqString(obj, "cursor"),
    reason: (reason as string | undefined) ?? undefined,
  };
}

export function parseBatchInput(body: unknown): BatchInput {
  const obj = asObject(body);
  return {
    batch_key: reqString(obj, "batch_key"),
    watermark: reqString(obj, "watermark"),
    events: optArray(obj, "events").map(parseEvent),
    withdrawals: optArray(obj, "withdrawals").map(parseWithdrawal),
  };
}

function batchSummary(row: BatchRow, replayed: boolean) {
  return {
    batch_id: row.batch_id,
    source_key: row.source_key,
    batch_key: row.batch_key,
    watermark: row.watermark,
    accepted_events: row.accepted_events,
    duplicate_events: row.duplicate_events,
    accepted_withdrawals: row.accepted_withdrawals,
    duplicate_withdrawals: row.duplicate_withdrawals,
    replayed,
  };
}

export function registerSource(db: Database.Database, sourceKey: string, displayName: string) {
  const result = db
    .prepare("INSERT OR IGNORE INTO source_registry (source_key, display_name) VALUES (?, ?)")
    .run(sourceKey, displayName);
  if (result.changes === 0) fail(409, "SOURCE_EXISTS", `来源 ${sourceKey} 已登记`);
  return { source_key: sourceKey, display_name: displayName };
}

export function getSource(db: Database.Database, sourceKey: string) {
  const source = db
    .prepare("SELECT source_key, display_name, created_at FROM source_registry WHERE source_key = ?")
    .get(sourceKey) as { source_key: string; display_name: string; created_at: string } | undefined;
  if (!source) fail(404, "SOURCE_NOT_FOUND", `来源 ${sourceKey} 未登记`);
  const watermark = db
    .prepare("SELECT watermark, updated_at FROM source_watermarks WHERE source_key = ?")
    .get(sourceKey) as { watermark: string; updated_at: string } | undefined;
  return { ...source, watermark: watermark?.watermark ?? null, watermark_updated_at: watermark?.updated_at ?? null };
}

/**
 * 接收一个来源批次。同一 (source_key, batch_key) 重放直接返回首次结果；
 * 事件与撤回按业务键幂等去重；来源水位只升不降。整个批次在一个事务内落库，
 * 进程中断不会产生半个批次。
 */
export function importBatch(db: Database.Database, sourceKey: string, input: BatchInput) {
  const source = db.prepare("SELECT source_key FROM source_registry WHERE source_key = ?").get(sourceKey);
  if (!source) fail(404, "SOURCE_NOT_FOUND", `来源 ${sourceKey} 未登记`);

  const existing = db
    .prepare("SELECT * FROM source_batches WHERE source_key = ? AND batch_key = ?")
    .get(sourceKey, input.batch_key) as BatchRow | undefined;
  if (existing) return batchSummary(existing, true);

  const run = db.transaction(() => {
    const inserted = db
      .prepare("INSERT INTO source_batches (source_key, batch_key, watermark) VALUES (?, ?, ?)")
      .run(sourceKey, input.batch_key, input.watermark);
    const batchId = Number(inserted.lastInsertRowid);

    let acceptedEvents = 0;
    let duplicateEvents = 0;
    const insertEvent = db.prepare(
      `INSERT OR IGNORE INTO complaint_events
         (source_key, source_event_id, business_cursor, complaint_month, merchant_alias, detail, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of input.events) {
      const result = insertEvent.run(
        sourceKey,
        event.source_event_id,
        event.cursor,
        event.complaint_month,
        event.merchant_alias,
        event.detail,
        batchId,
      );
      if (result.changes > 0) acceptedEvents += 1;
      else duplicateEvents += 1;
    }

    let acceptedWithdrawals = 0;
    let duplicateWithdrawals = 0;
    const insertWithdrawal = db.prepare(
      `INSERT OR IGNORE INTO withdrawal_events (source_key, source_event_id, business_cursor, reason, batch_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const withdrawal of input.withdrawals) {
      const result = insertWithdrawal.run(
        sourceKey,
        withdrawal.source_event_id,
        withdrawal.cursor,
        withdrawal.reason ?? null,
        batchId,
      );
      if (result.changes > 0) acceptedWithdrawals += 1;
      else duplicateWithdrawals += 1;
    }

    db.prepare(
      `INSERT INTO source_watermarks (source_key, watermark) VALUES (?, ?)
       ON CONFLICT(source_key) DO UPDATE SET watermark = MAX(source_watermarks.watermark, excluded.watermark),
                                              updated_at = CURRENT_TIMESTAMP`,
    ).run(sourceKey, input.watermark);

    db.prepare(
      `UPDATE source_batches
       SET accepted_events = ?, duplicate_events = ?, accepted_withdrawals = ?, duplicate_withdrawals = ?
       WHERE batch_id = ?`,
    ).run(acceptedEvents, duplicateEvents, acceptedWithdrawals, duplicateWithdrawals, batchId);
    return batchId;
  });

  const batchId = run.immediate();
  const row = db.prepare("SELECT * FROM source_batches WHERE batch_id = ?").get(batchId) as BatchRow;
  return batchSummary(row, false);
}

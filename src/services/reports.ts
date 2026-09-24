import type Database from "better-sqlite3";
import { fail } from "../errors.js";
import { asObject, checkMonth, optArray, optString, reqString } from "../validate.js";
import { effectiveAssignments } from "./classification.js";
import { resolveMerchant } from "./reference.js";

const UNCLASSIFIED = "UNCLASSIFIED";

function minCellSize(): number {
  return Number(process.env.MIN_CELL_SIZE ?? "5");
}

interface PublicationRow {
  publication_id: number;
  month: string;
  version_no: number;
  request_key: string | null;
  source_watermark: string;
  taxonomy_version: string;
  exclusion_reasons: string;
  published_by: string;
  published_at: string;
}

interface SnapshotRow {
  event_id: number;
  category_key: string;
  merchant_key: string;
}

function publicationView(row: PublicationRow) {
  return {
    publication_id: row.publication_id,
    month: row.month,
    version_no: row.version_no,
    request_key: row.request_key,
    source_watermark: JSON.parse(row.source_watermark) as Record<string, string>,
    taxonomy_version: row.taxonomy_version,
    exclusion_reasons: JSON.parse(row.exclusion_reasons) as string[],
    published_by: row.published_by,
    published_at: row.published_at,
  };
}

function latestPublication(db: Database.Database, month: string): PublicationRow {
  const row = db
    .prepare("SELECT * FROM report_publications WHERE month = ? ORDER BY version_no DESC LIMIT 1")
    .get(month) as PublicationRow | undefined;
  if (!row) fail(404, "PUBLICATION_NOT_FOUND", `月份 ${month} 尚未发布`);
  return row;
}

function snapshotRows(db: Database.Database, publicationId: number): SnapshotRow[] {
  return db
    .prepare("SELECT event_id, category_key, merchant_key FROM publication_events WHERE publication_id = ?")
    .all(publicationId) as SnapshotRow[];
}

/** 锁定词典版本中对该月有效的类别键。 */
function validCategoryKeys(db: Database.Database, taxonomyVersion: string, month: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT category_key FROM taxonomy_categories
       WHERE version_key = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .all(taxonomyVersion, month, month) as Array<{ category_key: string }>;
  return new Set(rows.map((row) => row.category_key));
}

interface CellAggregate {
  category_key: string;
  merchant_key: string;
  eventIds: Set<number>;
}

/** 汇总发布快照为细分单元；锁定词典中已失效的类别被排除并计数。 */
function aggregateCells(db: Database.Database, publication: PublicationRow) {
  const valid = validCategoryKeys(db, publication.taxonomy_version, publication.month);
  const rows = snapshotRows(db, publication.publication_id);
  const kept: SnapshotRow[] = [];
  const excludedEventIds = new Set<number>();
  const keptEventIds = new Set<number>();
  for (const row of rows) {
    if (row.category_key === UNCLASSIFIED || valid.has(row.category_key)) {
      kept.push(row);
      keptEventIds.add(row.event_id);
    } else {
      excludedEventIds.add(row.event_id);
    }
  }
  for (const eventId of keptEventIds) excludedEventIds.delete(eventId);

  const cells = new Map<string, CellAggregate>();
  for (const row of kept) {
    const key = `${row.category_key} ${row.merchant_key}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { category_key: row.category_key, merchant_key: row.merchant_key, eventIds: new Set() };
      cells.set(key, cell);
    }
    cell.eventIds.add(row.event_id);
  }
  return { kept, cells, excludedCount: excludedEventIds.size };
}

export interface PublishInput {
  taxonomy_version: string;
  published_by: string;
  exclusion_reasons: string[];
  request_key?: string;
}

export function parsePublishInput(body: unknown): PublishInput {
  const obj = asObject(body);
  const reasons = optArray(obj, "exclusion_reasons").map((reason, i) => {
    if (typeof reason !== "string" || reason.length === 0) {
      fail(400, "VALIDATION_FAILED", `exclusion_reasons[${i}] 必须是非空字符串`);
    }
    return reason;
  });
  return {
    taxonomy_version: reqString(obj, "taxonomy_version"),
    published_by: reqString(obj, "published_by"),
    exclusion_reasons: reasons,
    request_key: optString(obj, "request_key"),
  };
}

/**
 * 发布某月的新口径版本：锁定当前各来源水位、分类版本与排除理由，
 * 把当期计入的事件连同有效归类、归并商家一起冻结进快照。
 * 之后到达的迟到投诉、撤回与身份纠正不改动本版本，只会在下一次发布中体现。
 * 携带相同 request_key 的重复发布返回首次结果，不产生新版本。
 */
export function publishMonth(db: Database.Database, monthRaw: string, input: PublishInput) {
  const month = checkMonth(monthRaw, "month");
  const taxonomy = db
    .prepare("SELECT version_key FROM taxonomy_versions WHERE version_key = ?")
    .get(input.taxonomy_version);
  if (!taxonomy) fail(404, "TAXONOMY_VERSION_NOT_FOUND", `分类版本 ${input.taxonomy_version} 不存在`);

  if (input.request_key !== undefined) {
    const existing = db
      .prepare("SELECT * FROM report_publications WHERE month = ? AND request_key = ?")
      .get(month, input.request_key) as PublicationRow | undefined;
    if (existing) return { publication: publicationView(existing), replayed: true };
  }

  const publish = db.transaction(() => {
    const versionNo =
      ((db.prepare("SELECT MAX(version_no) AS v FROM report_publications WHERE month = ?").get(month) as { v: number | null }).v ?? 0) + 1;
    const watermarks = Object.fromEntries(
      (
        db.prepare("SELECT source_key, watermark FROM source_watermarks ORDER BY source_key").all() as Array<{
          source_key: string;
          watermark: string;
        }>
      ).map((row) => [row.source_key, row.watermark]),
    );
    const inserted = db
      .prepare(
        `INSERT INTO report_publications
           (month, version_no, request_key, source_watermark, taxonomy_version, exclusion_reasons, published_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        month,
        versionNo,
        input.request_key ?? null,
        JSON.stringify(watermarks),
        input.taxonomy_version,
        JSON.stringify(input.exclusion_reasons),
        input.published_by,
      );
    const publicationId = Number(inserted.lastInsertRowid);

    const events = db
      .prepare(
        "SELECT event_id, source_key, source_event_id, merchant_alias FROM complaint_events WHERE complaint_month = ? ORDER BY event_id",
      )
      .all(month) as Array<{ event_id: number; source_key: string; source_event_id: string; merchant_alias: string }>;
    const withdrawn = new Set(
      (
        db.prepare("SELECT source_key, source_event_id FROM withdrawal_events").all() as Array<{
          source_key: string;
          source_event_id: string;
        }>
      ).map((row) => `${row.source_key} ${row.source_event_id}`),
    );
    const assignments = effectiveAssignments(
      db,
      events.map((event) => event.event_id),
    );
    const insertSnapshot = db.prepare(
      "INSERT OR IGNORE INTO publication_events (publication_id, event_id, category_key, merchant_key) VALUES (?, ?, ?, ?)",
    );
    for (const event of events) {
      if (withdrawn.has(`${event.source_key} ${event.source_event_id}`)) continue;
      const assignment = assignments.get(event.event_id);
      if (assignment?.canonicalEventId && assignment.canonicalEventId !== event.event_id) continue; // 已并入其他事件
      const merchantKey = resolveMerchant(db, event.merchant_alias, month);
      const categories = assignment && assignment.categories.size > 0 ? [...assignment.categories] : [UNCLASSIFIED];
      for (const category of categories) insertSnapshot.run(publicationId, event.event_id, category, merchantKey);
    }
    return publicationId;
  });

  const publicationId = publish.immediate();
  const row = db.prepare("SELECT * FROM report_publications WHERE publication_id = ?").get(publicationId) as PublicationRow;
  return { publication: publicationView(row), replayed: false };
}

interface EventSnapshot {
  categories: Set<string>;
  merchant: string;
}

function snapshotByEvent(db: Database.Database, publicationId: number): Map<number, EventSnapshot> {
  const map = new Map<number, EventSnapshot>();
  for (const row of snapshotRows(db, publicationId)) {
    let entry = map.get(row.event_id);
    if (!entry) {
      entry = { categories: new Set(), merchant: row.merchant_key };
      map.set(row.event_id, entry);
    }
    entry.categories.add(row.category_key);
    entry.merchant = row.merchant_key;
  }
  return map;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** 月报页面：当期数字、与上一发布版的差异来源、未决候选数。 */
export function getMonthlyReport(db: Database.Database, monthRaw: string) {
  const month = checkMonth(monthRaw, "month");
  const publication = latestPublication(db, month);
  const { cells, excludedCount } = aggregateCells(db, publication);
  const threshold = minCellSize();

  const cellList = [...cells.values()]
    .sort((a, b) => a.category_key.localeCompare(b.category_key) || a.merchant_key.localeCompare(b.merchant_key))
    .map((cell) => {
      const suppressed = cell.eventIds.size < threshold;
      return {
        category_key: cell.category_key,
        merchant_key: cell.merchant_key,
        count: suppressed ? null : cell.eventIds.size,
        suppressed,
      };
    });
  const totalComplaints = new Set(
    [...cells.values()].flatMap((cell) => [...cell.eventIds]),
  ).size;

  const previous = db
    .prepare("SELECT * FROM report_publications WHERE month = ? AND version_no < ? ORDER BY version_no DESC LIMIT 1")
    .get(month, publication.version_no) as PublicationRow | undefined;
  let diff: Record<string, unknown> = { compared_to_version: null };
  if (previous) {
    const current = snapshotByEvent(db, publication.publication_id);
    const prior = snapshotByEvent(db, previous.publication_id);
    const withdrawn = new Set(
      (
        db.prepare("SELECT source_key, source_event_id FROM withdrawal_events").all() as Array<{
          source_key: string;
          source_event_id: string;
        }>
      ).map((row) => `${row.source_key} ${row.source_event_id}`),
    );
    const eventKeys = new Map(
      (
        db.prepare("SELECT event_id, source_key, source_event_id FROM complaint_events").all() as Array<{
          event_id: number;
          source_key: string;
          source_event_id: string;
        }>
      ).map((row) => [row.event_id, `${row.source_key} ${row.source_event_id}`]),
    );
    let added = 0;
    let withdrawnCount = 0;
    let merged = 0;
    let identityChanged = 0;
    let categoryChanged = 0;
    for (const eventId of current.keys()) if (!prior.has(eventId)) added += 1;
    for (const eventId of prior.keys()) {
      if (current.has(eventId)) continue;
      if (withdrawn.has(eventKeys.get(eventId) ?? "")) withdrawnCount += 1;
      else merged += 1;
    }
    for (const [eventId, now] of current) {
      const before = prior.get(eventId);
      if (!before) continue;
      if (now.merchant !== before.merchant) identityChanged += 1;
      else if (!sameSet(now.categories, before.categories)) categoryChanged += 1;
    }
    diff = {
      compared_to_version: previous.version_no,
      added,
      withdrawn: withdrawnCount,
      merged,
      identity_changed: identityChanged,
      category_changed: categoryChanged,
    };
  }

  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM classification_candidates c
       JOIN complaint_events e ON e.event_id = c.event_id
       WHERE e.complaint_month = ?
         AND NOT EXISTS (SELECT 1 FROM classification_decisions d WHERE d.candidate_id = c.candidate_id)`,
    )
    .get(month) as { n: number };

  return {
    month,
    publication: publicationView(publication),
    totals: { complaints: totalComplaints, excluded_events: excludedCount },
    min_cell_size: threshold,
    cells: cellList,
    diff,
    pending_candidates: pending.n,
  };
}

export function setViewerScopes(db: Database.Database, actor: string, scopes: Array<{ scope_type: string; scope_value: string }>) {
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM viewer_scopes WHERE actor = ?").run(actor);
    const insert = db.prepare("INSERT OR IGNORE INTO viewer_scopes (actor, scope_type, scope_value) VALUES (?, ?, ?)");
    for (const scope of scopes) insert.run(actor, scope.scope_type, scope.scope_value);
  });
  replace.immediate();
  return db.prepare("SELECT scope_type, scope_value FROM viewer_scopes WHERE actor = ? ORDER BY scope_type, scope_value").all(actor);
}

export function getViewerScopes(db: Database.Database, actor: string) {
  return db.prepare("SELECT scope_type, scope_value FROM viewer_scopes WHERE actor = ? ORDER BY scope_type, scope_value").all(actor);
}

/**
 * 下钻到某细分单元的去标识化证据。样本过少的单元被抑制不可下钻；
 * 查看者只能进入其职责范围（类别范围）内的单元。
 */
export function drilldown(db: Database.Database, monthRaw: string, query: { category_key: string; merchant_key: string }, actor: string | undefined) {
  const month = checkMonth(monthRaw, "month");
  if (!actor) fail(401, "ACTOR_REQUIRED", "缺少 x-actor 请求头");
  const publication = latestPublication(db, month);
  const { cells } = aggregateCells(db, publication);
  const cell = cells.get(`${query.category_key} ${query.merchant_key}`);
  if (!cell) fail(404, "CELL_NOT_FOUND", `月份 ${month} 不存在该细分单元`);

  const allowed = db
    .prepare(
      `SELECT 1 FROM viewer_scopes
       WHERE actor = ? AND scope_type = 'category' AND (scope_value = '*' OR scope_value = ?) LIMIT 1`,
    )
    .get(actor, query.category_key);
  if (!allowed) fail(403, "SCOPE_DENIED", "该查看者无权下钻此类别");
  if (cell.eventIds.size < minCellSize()) fail(403, "CELL_SUPPRESSED", "该细分单元样本过少，已抑制");

  const ids = [...cell.eventIds].sort((a, b) => a - b);
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT event_id, complaint_month, merchant_alias, detail, received_at
       FROM complaint_events WHERE event_id IN (${placeholders}) ORDER BY event_id`,
    )
    .all(...ids) as Array<{
    event_id: number;
    complaint_month: string;
    merchant_alias: string;
    detail: string;
    received_at: string;
  }>;
  return {
    month,
    category_key: query.category_key,
    merchant_key: query.merchant_key,
    publication_version: publication.version_no,
    events: rows.map((row) => ({
      event_ref: `evt_${row.event_id}`,
      complaint_month: row.complaint_month,
      category_key: query.category_key,
      merchant_key: query.merchant_key,
      detail: row.detail,
      received_at: row.received_at,
    })),
  };
}

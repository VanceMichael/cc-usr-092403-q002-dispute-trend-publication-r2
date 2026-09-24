import type Database from "better-sqlite3";
import { fail } from "../errors.js";
import { asObject, optInt, reqString } from "../validate.js";

export interface RunView {
  run_id: number;
  rule_version: string;
  taxonomy_version: string;
  page_size: number;
  status: string;
  checkpoint: number;
  processed_total: number;
}

export function getRun(db: Database.Database, runId: number): RunView {
  const run = db.prepare("SELECT * FROM classification_runs WHERE run_id = ?").get(runId) as RunView | undefined;
  if (!run) fail(404, "RUN_NOT_FOUND", `归类作业 ${runId} 不存在`);
  return run;
}

export function createRun(db: Database.Database, body: unknown): RunView {
  const obj = asObject(body);
  const ruleVersion = reqString(obj, "rule_version");
  const taxonomyVersion = reqString(obj, "taxonomy_version");
  const pageSize = optInt(obj, "page_size") ?? 100;
  const taxonomy = db
    .prepare("SELECT version_key FROM taxonomy_versions WHERE version_key = ?")
    .get(taxonomyVersion);
  if (!taxonomy) fail(404, "TAXONOMY_VERSION_NOT_FOUND", `分类版本 ${taxonomyVersion} 不存在`);
  const inserted = db
    .prepare("INSERT INTO classification_runs (rule_version, taxonomy_version, page_size) VALUES (?, ?, ?)")
    .run(ruleVersion, taxonomyVersion, pageSize);
  return getRun(db, Number(inserted.lastInsertRowid));
}

/**
 * 推进归类作业一页。整页在一个事务内完成：候选写入与检查点推进同生共死，
 * 进程在页内任何位置中断都不会留下半页状态，下次 advance 从检查点继续。
 * 候选按 (event_id, rule_version, category_key) 幂等，重复推进不多产一条。
 */
export function advanceRun(db: Database.Database, runId: number): RunView {
  const run = getRun(db, runId);
  if (run.status === "completed") return run;

  const step = db.transaction(() => {
    const events = db
      .prepare("SELECT event_id, detail FROM complaint_events WHERE event_id > ? ORDER BY event_id LIMIT ?")
      .all(run.checkpoint, run.page_size) as Array<{ event_id: number; detail: string }>;
    if (events.length === 0) {
      db.prepare("UPDATE classification_runs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE run_id = ?").run(runId);
      return;
    }
    const categories = db
      .prepare("SELECT category_key, keywords FROM taxonomy_categories WHERE version_key = ?")
      .all(run.taxonomy_version) as Array<{ category_key: string; keywords: string }>;
    const insertCandidate = db.prepare(
      `INSERT OR IGNORE INTO classification_candidates (event_id, run_id, rule_version, category_key, confidence)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      const detail = event.detail.toLowerCase();
      for (const category of categories) {
        const keywords = JSON.parse(category.keywords) as string[];
        if (keywords.length === 0) continue;
        const matched = keywords.filter((keyword) => keyword.length > 0 && detail.includes(keyword.toLowerCase()));
        if (matched.length === 0) continue;
        insertCandidate.run(event.event_id, runId, run.rule_version, category.category_key, matched.length / keywords.length);
      }
    }
    const lastEventId = events[events.length - 1].event_id;
    db.prepare(
      `UPDATE classification_runs
       SET status = 'running', checkpoint = ?, processed_total = processed_total + ?, updated_at = CURRENT_TIMESTAMP
       WHERE run_id = ?`,
    ).run(lastEventId, events.length, runId);
  });
  step.immediate();
  return getRun(db, runId);
}

const ACTIONS = new Set(["confirm", "reject", "split", "merge"]);

export interface DecisionInput {
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}

export function parseDecisionInput(body: unknown): DecisionInput {
  const obj = asObject(body);
  const action = reqString(obj, "action");
  if (!ACTIONS.has(action)) fail(400, "VALIDATION_FAILED", `action 必须是 ${[...ACTIONS].join("/")} 之一`);
  const actor = reqString(obj, "actor");
  const rawDetail = obj.detail;
  const detail = rawDetail === undefined || rawDetail === null ? {} : asObject(rawDetail, "detail");
  if (action === "split") {
    const categories = detail.categories;
    if (!Array.isArray(categories) || categories.length === 0 || categories.some((c) => typeof c !== "string" || c.length === 0)) {
      fail(400, "VALIDATION_FAILED", "split 处置的 detail.categories 必须是非空字符串数组");
    }
  }
  if (action === "merge") {
    const canonical = detail.canonical_event_id;
    if (!Number.isInteger(canonical) || (canonical as number) <= 0) {
      fail(400, "VALIDATION_FAILED", "merge 处置的 detail.canonical_event_id 必须是正整数");
    }
  }
  return { action, actor, detail };
}

/** 人工处置只追加新行，候选与历史处置保持原样。 */
export function addDecision(db: Database.Database, candidateId: number, input: DecisionInput) {
  const candidate = db
    .prepare("SELECT candidate_id FROM classification_candidates WHERE candidate_id = ?")
    .get(candidateId);
  if (!candidate) fail(404, "CANDIDATE_NOT_FOUND", `候选 ${candidateId} 不存在`);
  const inserted = db
    .prepare("INSERT INTO classification_decisions (candidate_id, action, detail, actor) VALUES (?, ?, ?, ?)")
    .run(candidateId, input.action, JSON.stringify(input.detail), input.actor);
  return db
    .prepare("SELECT * FROM classification_decisions WHERE decision_id = ?")
    .get(Number(inserted.lastInsertRowid)) as Record<string, unknown>;
}

export function listDecisions(db: Database.Database, candidateId: number) {
  const candidate = db
    .prepare("SELECT candidate_id FROM classification_candidates WHERE candidate_id = ?")
    .get(candidateId);
  if (!candidate) fail(404, "CANDIDATE_NOT_FOUND", `候选 ${candidateId} 不存在`);
  const rows = db
    .prepare("SELECT * FROM classification_decisions WHERE candidate_id = ? ORDER BY decision_id")
    .all(candidateId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail as string) }));
}

export function listCandidates(db: Database.Database, month: string | undefined, pendingOnly: boolean) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (month) {
    clauses.push("e.complaint_month = ?");
    params.push(month);
  }
  if (pendingOnly) {
    clauses.push("NOT EXISTS (SELECT 1 FROM classification_decisions d WHERE d.candidate_id = c.candidate_id)");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT c.candidate_id, c.event_id, c.rule_version, c.category_key, c.confidence, c.created_at,
              e.complaint_month, e.merchant_alias,
              EXISTS (SELECT 1 FROM classification_decisions d WHERE d.candidate_id = c.candidate_id) AS decided
       FROM classification_candidates c
       JOIN complaint_events e ON e.event_id = c.event_id
       ${where}
       ORDER BY c.candidate_id`,
    )
    .all(...params);
}

export interface EffectiveAssignment {
  categories: Set<string>;
  canonicalEventId: number | null;
}

/**
 * 汇总一组事件的当前有效归类：每个候选取其最新处置，
 * confirm 采用候选类别，split 采用拆分出的类别集合，reject 不贡献类别；
 * merge 给出事件应并入的 canonical_event_id。无处置的候选保持未决，不影响有效口径。
 */
export function effectiveAssignments(db: Database.Database, eventIds: number[]): Map<number, EffectiveAssignment> {
  const result = new Map<number, EffectiveAssignment>();
  if (eventIds.length === 0) return result;
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT c.candidate_id, c.event_id, c.category_key, d.action, d.detail, d.decision_id
       FROM classification_candidates c
       LEFT JOIN classification_decisions d ON d.candidate_id = c.candidate_id
       WHERE c.event_id IN (${placeholders})
       ORDER BY c.candidate_id, d.decision_id`,
    )
    .all(...eventIds) as Array<{
    candidate_id: number;
    event_id: number;
    category_key: string;
    action: string | null;
    detail: string | null;
    decision_id: number | null;
  }>;

  const latestByCandidate = new Map<number, (typeof rows)[number]>();
  const categoryByCandidate = new Map<number, { event_id: number; category_key: string }>();
  for (const row of rows) {
    categoryByCandidate.set(row.candidate_id, { event_id: row.event_id, category_key: row.category_key });
    if (row.decision_id !== null) latestByCandidate.set(row.candidate_id, row);
  }

  const ensure = (eventId: number): EffectiveAssignment => {
    let assignment = result.get(eventId);
    if (!assignment) {
      assignment = { categories: new Set<string>(), canonicalEventId: null };
      result.set(eventId, assignment);
    }
    return assignment;
  };

  const latestMergeByEvent = new Map<number, { decisionId: number; canonicalEventId: number }>();
  for (const [candidateId, decision] of latestByCandidate) {
    const candidate = categoryByCandidate.get(candidateId)!;
    const assignment = ensure(candidate.event_id);
    const detail = decision.detail ? (JSON.parse(decision.detail) as Record<string, unknown>) : {};
    switch (decision.action) {
      case "confirm":
        assignment.categories.add(candidate.category_key);
        break;
      case "split":
        for (const category of (detail.categories as string[]) ?? []) assignment.categories.add(category);
        break;
      case "merge": {
        const canonical = detail.canonical_event_id as number;
        const current = latestMergeByEvent.get(candidate.event_id);
        if (!current || decision.decision_id! > current.decisionId) {
          latestMergeByEvent.set(candidate.event_id, { decisionId: decision.decision_id!, canonicalEventId: canonical });
        }
        break;
      }
      default:
        break; // reject 不贡献类别
    }
  }
  for (const [eventId, merge] of latestMergeByEvent) {
    ensure(eventId).canonicalEventId = merge.canonicalEventId;
  }
  return result;
}

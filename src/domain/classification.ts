import type Database from "better-sqlite3";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";
import { classifyText } from "./taxonomy.js";

const BATCH_SIZE = 100;
const STALE_HEARTBEAT_MS = 30_000;

export interface JobView {
  id: number;
  taxonomyVersion: string;
  scopeMonth: string | null;
  state: string;
  total: number | null;
  processed: number;
}

function loadJob(db: Database.Database, id: number) {
  const job = db
    .prepare(
      `SELECT id, taxonomy_version AS taxonomyVersion, scope_month AS scopeMonth, state,
              cursor_id AS cursorId, total, processed, claimed_by AS claimedBy, heartbeat_at AS heartbeatAt
       FROM classification_jobs WHERE id = ?`,
    )
    .get(id) as
    | {
        id: number;
        taxonomyVersion: string;
        scopeMonth: string | null;
        state: string;
        cursorId: number;
        total: number | null;
        processed: number;
        claimedBy: string | null;
        heartbeatAt: string | null;
      }
    | undefined;
  if (!job) throw new DomainError("JOB_NOT_FOUND", `归类任务不存在: ${id}`);
  return job;
}

export function createJob(
  taxonomyVersion: string,
  options: { scopeMonth?: string | null; worker?: string } = {},
  db: Database.Database = rawDb(),
): JobView {
  const version = db.prepare("SELECT 1 FROM taxonomy_versions WHERE version = ?").get(taxonomyVersion);
  if (!version) throw new DomainError("TAXONOMY_VERSION_NOT_FOUND", `分类版本不存在: ${taxonomyVersion}`);

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO classification_jobs(taxonomy_version, scope_month, state) VALUES (?,?,'pending')",
      )
      .run(taxonomyVersion, options.scopeMonth ?? null);
    const total = db
      .prepare(
        `SELECT COUNT(*) AS n FROM complaints ${options.scopeMonth ? "WHERE complaint_month = ?" : ""}`,
      )
      .get(...(options.scopeMonth ? [options.scopeMonth] : [])) as { n: number };
    db.prepare("UPDATE classification_jobs SET total = ? WHERE id = ?").run(
      total.n,
      Number(info.lastInsertRowid),
    );
    return Number(info.lastInsertRowid);
  });
  const id = tx.immediate();
  return getJob(id, db);
}

export function getJob(id: number, db: Database.Database = rawDb()): JobView {
  const job = loadJob(db, id);
  return {
    id: job.id,
    taxonomyVersion: job.taxonomyVersion,
    scopeMonth: job.scopeMonth,
    state: job.state,
    total: job.total,
    processed: job.processed,
  };
}

/**
 * 运行（或继续）一个归类任务。
 * - 从未处理的 cursor_id 之后继续，进程中断后重跑不会重复归类
 * - 心跳超时的 running 任务视为 interrupted 并可被重新认领
 * - 自动归类只 upsert 候选；已有候选（含人工已决策）绝不被覆盖
 */
export function runJob(
  id: number,
  options: { worker?: string; staleMs?: number } = {},
  db: Database.Database = rawDb(),
): JobView {
  const staleMs = options.staleMs ?? STALE_HEARTBEAT_MS;

  const claim = db.transaction(() => {
    const job = loadJob(db, id);
    if (job.state === "completed") return { claimed: false as const };
    if (job.state === "running") {
      const fresh =
        job.heartbeatAt && Date.now() - new Date(job.heartbeatAt + "Z").getTime() < staleMs;
      if (fresh && job.claimedBy !== options.worker) {
        throw new DomainError("INVALID_PAYLOAD", "任务正在被其他进程处理", { jobId: id });
      }
    }
    db.prepare(
      `UPDATE classification_jobs
       SET state = 'running', claimed_by = ?, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(options.worker ?? "worker", id);
    return { claimed: true as const };
  });
  claim.immediate();

  try {
    for (;;) {
      const done = processBatch(db, id);
      if (done) break;
    }
    db.prepare("UPDATE classification_jobs SET state = 'completed' WHERE id = ?").run(id);
  } catch (error) {
    db.prepare(
      "UPDATE classification_jobs SET state = 'interrupted', last_error = ? WHERE id = ?",
    ).run(error instanceof Error ? error.message : String(error), id);
    throw error;
  }
  return getJob(id, db);
}

/** 处理一批，返回是否全部完成 */
function processBatch(db: Database.Database, jobId: number): boolean {
  const tx = db.transaction((): boolean => {
    const job = loadJob(db, jobId);
    const rows = db
      .prepare(
        `SELECT id, category_raw AS categoryRaw, event_time AS eventTime
         FROM complaints WHERE id > ? ${job.scopeMonth ? "AND complaint_month = ?" : ""}
         ORDER BY id ASC LIMIT ?`,
      )
      .all(...(job.scopeMonth ? [job.cursorId, job.scopeMonth, BATCH_SIZE] : [job.cursorId, BATCH_SIZE])) as {
      id: number;
      categoryRaw: string;
      eventTime: string;
    }[];

    if (rows.length === 0) return true;

    for (const row of rows) {
      const proposed = classifyText(job.taxonomyVersion, row.categoryRaw, row.eventTime, db);
      db.prepare(
        `INSERT INTO classification_candidates
           (complaint_id, taxonomy_version, proposed_term_code, method, state, job_id)
         VALUES (?, ?, ?, 'auto', 'pending', ?)
         ON CONFLICT(complaint_id, taxonomy_version) DO UPDATE SET
           proposed_term_code = COALESCE(classification_candidates.proposed_term_code, excluded.proposed_term_code),
           job_id = COALESCE(classification_candidates.job_id, excluded.job_id)`,
      ).run(row.id, job.taxonomyVersion, proposed, jobId);
    }

    const lastId = rows[rows.length - 1].id;
    db.prepare(
      `UPDATE classification_jobs
       SET cursor_id = ?, processed = ?, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(lastId, job.processed + rows.length, jobId);
    return rows.length < BATCH_SIZE;
  });
  return tx.immediate();
}

export interface CandidateView {
  candidateId: number;
  complaintId: number;
  taxonomyVersion: string;
  proposedTermCode: string | null;
  state: string;
  confirmedTermCode: string | null;
  decidedBy: string | null;
}

export function listCandidates(
  filter: { month?: string; state?: string } = {},
  db: Database.Database = rawDb(),
): CandidateView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.month) {
    where.push("c.complaint_month = ?");
    params.push(filter.month);
  }
  if (filter.state) {
    where.push("cc.state = ?");
    params.push(filter.state);
  }
  return db
    .prepare(
      `SELECT cc.id AS candidateId, cc.complaint_id AS complaintId, cc.taxonomy_version AS taxonomyVersion,
              cc.proposed_term_code AS proposedTermCode, cc.state AS state,
              cc.confirmed_term_code AS confirmedTermCode, cc.decided_by AS decidedBy
       FROM classification_candidates cc JOIN complaints c ON c.id = cc.complaint_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY cc.id`,
    )
    .all(...params) as CandidateView[];
}

export interface DecisionInput {
  candidateId: number;
  action: "confirm" | "reject";
  /** confirm 时可指定与自动建议不同的词条；缺省采用建议词条 */
  termCode?: string | null;
  decidedBy: string;
}

/** 人工确认/否决候选。决策写在候选行的独立字段，原始投诉永不变更 */
export function decideCandidate(input: DecisionInput, db: Database.Database = rawDb()): CandidateView {
  const tx = db.transaction((): CandidateView => {
    const candidate = db
      .prepare(
        `SELECT id, state, proposed_term_code AS proposed, taxonomy_version AS version
         FROM classification_candidates WHERE id = ?`,
      )
      .get(input.candidateId) as
      | { id: number; state: string; proposed: string | null; version: string }
      | undefined;
    if (!candidate) throw new DomainError("CANDIDATE_NOT_FOUND", `候选不存在: ${input.candidateId}`);
    if (candidate.state !== "pending") {
      throw new DomainError("ALREADY_DECIDED", "候选已被人工处理，不能覆盖既有决策", {
        candidateId: input.candidateId,
        state: candidate.state,
      });
    }

    let termCode: string | null = null;
    if (input.action === "confirm") {
      termCode = input.termCode ?? candidate.proposed;
      if (!termCode) throw new DomainError("INVALID_PAYLOAD", "无建议词条时必须显式给出 termCode");
      const term = db
        .prepare("SELECT 1 FROM taxonomy_terms WHERE version = ? AND code = ?")
        .get(candidate.version, termCode);
      if (!term) throw new DomainError("TERM_NOT_FOUND", `词条不存在: ${termCode}`);
    }

    db.prepare(
      `UPDATE classification_candidates
       SET state = ?, confirmed_term_code = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(input.action === "confirm" ? "confirmed" : "rejected", termCode, `manual:${input.decidedBy}`, input.candidateId);

    return (db
      .prepare(
        `SELECT id AS candidateId, complaint_id AS complaintId, taxonomy_version AS taxonomyVersion,
                proposed_term_code AS proposedTermCode, state,
                confirmed_term_code AS confirmedTermCode, decided_by AS decidedBy
         FROM classification_candidates WHERE id = ?`,
      )
      .get(input.candidateId)) as CandidateView;
  });
  return tx.immediate();
}

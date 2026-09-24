// 领域内通用的稳定机器可读错误码
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type ErrorCode =
  | "SOURCE_NOT_REGISTERED"
  | "BATCH_WATERMARK_CONFLICT"
  | "BATCH_CONTENT_CONFLICT"
  | "ALIAS_RANGE_OVERLAP"
  | "MERGE_RANGE_OVERLAP"
  | "MERGE_CYCLE"
  | "MERGE_NOT_FOUND"
  | "MERCHANT_NOT_FOUND"
  | "TAXONOMY_VERSION_NOT_FOUND"
  | "TERM_NOT_FOUND"
  | "RULE_RANGE_OVERLAP"
  | "CANDIDATE_NOT_FOUND"
  | "ALREADY_DECIDED"
  | "JOB_NOT_FOUND"
  | "PUBLICATION_NOT_FOUND"
  | "MONTH_ALREADY_PUBLISHED_AT_FINGERPRINT"
  | "FORBIDDEN_SCOPE"
  | "INVALID_PAYLOAD";

export interface BatchImportItem {
  sourceRef: string;
  pseudonym: string;
  eventTime: string; // YYYY-MM-DD
  merchantAlias: string;
  categoryRaw: string;
  facts?: Record<string, unknown>;
  withdrawn?: { eventTime: string; sourceEventRef: string };
}

/** 迟到的生命周期事件（撤回可在投诉入库后单独到达） */
export interface BatchEventItem {
  /** 已入库投诉的来源业务号 */
  complaintRef: string;
  sourceEventRef: string;
  eventTime: string;
}

export interface BatchImportRequest {
  sourceKey: string;
  batchRef: string;
  watermark: number;
  complaints?: BatchImportItem[];
  withdrawals?: BatchEventItem[];
  contentHash?: string;
}

export interface BatchImportResult {
  batchId: number;
  duplicated: boolean;
  importedComplaints: number;
  importedWithdrawals: number;
}

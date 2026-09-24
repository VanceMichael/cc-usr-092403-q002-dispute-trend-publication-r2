import type { FastifyReply } from "fastify";
import { DomainError, type ErrorCode } from "../domain/types.js";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  SOURCE_NOT_REGISTERED: 404,
  BATCH_WATERMARK_CONFLICT: 409,
  BATCH_CONTENT_CONFLICT: 409,
  ALIAS_RANGE_OVERLAP: 409,
  MERGE_RANGE_OVERLAP: 409,
  MERGE_CYCLE: 422,
  MERGE_NOT_FOUND: 404,
  MERCHANT_NOT_FOUND: 404,
  TAXONOMY_VERSION_NOT_FOUND: 404,
  TERM_NOT_FOUND: 404,
  RULE_RANGE_OVERLAP: 409,
  CANDIDATE_NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  JOB_NOT_FOUND: 404,
  PUBLICATION_NOT_FOUND: 404,
  MONTH_ALREADY_PUBLISHED_AT_FINGERPRINT: 409,
  FORBIDDEN_SCOPE: 403,
  INVALID_PAYLOAD: 400,
};

export function sendDomainError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DomainError) {
    return reply.status(STATUS_BY_CODE[error.code] ?? 500).send({
      error: { code: error.code, message: error.message, details: error.details ?? {} },
    });
  }
  throw error;
}

import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { fail } from "./errors.js";
import {
  addDecision,
  advanceRun,
  createRun,
  getRun,
  listCandidates,
  listDecisions,
  parseDecisionInput,
} from "./services/classification.js";
import { getSource, importBatch, parseBatchInput, registerSource } from "./services/imports.js";
import {
  addIdentityMapping,
  createTaxonomyVersion,
  getTaxonomyVersion,
  listIdentityMappings,
} from "./services/reference.js";
import {
  drilldown,
  getMonthlyReport,
  getViewerScopes,
  parsePublishInput,
  publishMonth,
  setViewerScopes,
} from "./services/reports.js";
import { asObject, optString, reqArray, reqString } from "./validate.js";

function idParam(params: unknown, name: string): number {
  const raw = (params as Record<string, string>)[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(400, "VALIDATION_FAILED", `路径参数 ${name} 必须是正整数`);
  return value;
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  // 来源与批次导入
  app.post("/sources", async (request) => {
    const body = asObject(request.body);
    return registerSource(db, reqString(body, "source_key"), reqString(body, "display_name"));
  });
  app.get("/sources/:sourceKey", async (request) => getSource(db, (request.params as Record<string, string>).sourceKey));
  app.post("/sources/:sourceKey/batches", async (request, reply) => {
    const input = parseBatchInput(request.body);
    const summary = importBatch(db, (request.params as Record<string, string>).sourceKey, input);
    return reply.status(summary.replayed ? 200 : 201).send(summary);
  });

  // 商家身份区间
  app.post("/merchant-identities", async (request, reply) => {
    return reply.status(201).send(addIdentityMapping(db, request.body));
  });
  app.get("/merchant-identities", async (request) => {
    const alias = optString((request.query ?? {}) as Record<string, unknown>, "alias");
    return { mappings: listIdentityMappings(db, alias) };
  });

  // 分类词典版本
  app.post("/taxonomy/versions", async (request, reply) => {
    return reply.status(201).send(createTaxonomyVersion(db, request.body));
  });
  app.get("/taxonomy/versions/:versionKey", async (request) =>
    getTaxonomyVersion(db, (request.params as Record<string, string>).versionKey),
  );

  // 归类作业与候选
  app.post("/classification/runs", async (request, reply) => {
    return reply.status(201).send(createRun(db, request.body));
  });
  app.get("/classification/runs/:runId", async (request) => getRun(db, idParam(request.params, "runId")));
  app.post("/classification/runs/:runId/advance", async (request) => advanceRun(db, idParam(request.params, "runId")));
  app.get("/classification/candidates", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const month = optString(query, "month");
    const pending = optString(query, "pending") === "true";
    return { candidates: listCandidates(db, month, pending) };
  });
  app.post("/classification/candidates/:candidateId/decisions", async (request, reply) => {
    const input = parseDecisionInput(request.body);
    return reply.status(201).send(addDecision(db, idParam(request.params, "candidateId"), input));
  });
  app.get("/classification/candidates/:candidateId/decisions", async (request) => ({
    decisions: listDecisions(db, idParam(request.params, "candidateId")),
  }));

  // 查看者职责范围
  app.put("/viewers/:actor/scopes", async (request) => {
    const actor = (request.params as Record<string, string>).actor;
    const body = asObject(request.body);
    const scopes = reqArray(body, "scopes").map((value, i) => {
      const scope = asObject(value, `scopes[${i}]`);
      const scopeType = reqString(scope, "scope_type");
      if (scopeType !== "category") fail(400, "VALIDATION_FAILED", `scopes[${i}].scope_type 目前只支持 category`);
      return { scope_type: scopeType, scope_value: reqString(scope, "scope_value") };
    });
    return { scopes: setViewerScopes(db, actor, scopes) };
  });
  app.get("/viewers/:actor/scopes", async (request) => ({
    scopes: getViewerScopes(db, (request.params as Record<string, string>).actor),
  }));

  // 发布与月报
  app.post("/reports/:month/publish", async (request, reply) => {
    const input = parsePublishInput(request.body);
    const result = publishMonth(db, (request.params as Record<string, string>).month, input);
    return reply.status(result.replayed ? 200 : 201).send(result);
  });
  app.get("/reports/:month", async (request) => getMonthlyReport(db, (request.params as Record<string, string>).month));
  app.get("/reports/:month/drilldown", async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const actor = request.headers["x-actor"];
    return drilldown(
      db,
      (request.params as Record<string, string>).month,
      { category_key: reqString(query, "category_key"), merchant_key: reqString(query, "merchant_key") },
      typeof actor === "string" ? actor : undefined,
    );
  });
}

import type { FastifyInstance } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { registerSource } from "../domain/sources.js";
import { ingestBatch } from "../domain/ingestion.js";
import {
  createMerchant,
  mapAlias,
  mergeMerchants,
  correctMerge,
} from "../domain/identity.js";
import {
  createTaxonomyVersion,
  putTerms,
  putRules,
  type RuleInput,
  type TermInput,
} from "../domain/taxonomy.js";
import {
  createJob,
  runJob,
  getJob,
  listCandidates,
  decideCandidate,
} from "../domain/classification.js";
import { publishMonth } from "../domain/publication.js";
import { monthlyReport, drilldown } from "../domain/reporting.js";
import { createUser, grantScope } from "../domain/access.js";
import { DomainError } from "../domain/types.js";
import { sendDomainError } from "./errors.js";

interface JsonBody { [key: string]: unknown }

function str(body: JsonBody | undefined, key: string): string {
  const value = body?.[key];
  if (typeof value !== "string" || !value) throw new DomainError("INVALID_PAYLOAD", `缺少字段: ${key}`);
  return value;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // ---- 基础登记 ----
  app.post("/admin/sources", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      registerSource(str(body, "sourceKey"), str(body, "displayName"));
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/admin/users", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const role = body.role;
      if (role !== "publisher" && role !== "analyst" && role !== "viewer") {
        return reply.status(400).send({ error: { code: "INVALID_PAYLOAD", message: "role 非法" } });
      }
      createUser(str(body, "userId"), str(body, "displayName"), role);
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/admin/users/:userId/scopes", async (request, reply) => {
    try {
      const { userId } = request.params as { userId: string };
      const body = request.body as JsonBody;
      const dimension = body.dimension;
      if (dimension !== "merchant" && dimension !== "category" && dimension !== "all") {
        return reply.status(400).send({ error: { code: "INVALID_PAYLOAD", message: "dimension 非法" } });
      }
      grantScope(userId, dimension, typeof body.scopeValue === "string" ? body.scopeValue : "*");
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 来源批次接收（按业务水位幂等） ----
  app.post("/ingest/batches", async (request, reply) => {
    try {
      const result = ingestBatch(request.body as Parameters<typeof ingestBatch>[0]);
      return reply.status(result.duplicated ? 200 : 201).send(result);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 商家身份 ----
  app.post("/merchants", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const merchant = createMerchant(str(body, "merchantRef"), str(body, "displayPseudonym"));
      return reply.status(201).send(merchant);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/identity/map-alias", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const actor = actorHeader(request.headers);
      mapAlias({
        alias: str(body, "alias"),
        targetMerchantRef: str(body, "targetMerchantRef"),
        validFrom: str(body, "validFrom"),
        validTo: (body.validTo as string | null) ?? null,
        decidedBy: actor,
        note: body.note as string | undefined,
        splitFromOpenAuto: body.splitFromOpenAuto === true,
      });
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/identity/merge", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      mergeMerchants({
        sourceMerchantRef: str(body, "sourceMerchantRef"),
        targetMerchantRef: str(body, "targetMerchantRef"),
        validFrom: str(body, "validFrom"),
        validTo: (body.validTo as string | null) ?? null,
        decidedBy: actorHeader(request.headers),
        note: body.note as string | undefined,
      });
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/identity/correct-merge", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      correctMerge({
        sourceMerchantRef: str(body, "sourceMerchantRef"),
        newTargetMerchantRef: str(body, "newTargetMerchantRef"),
        validFrom: str(body, "validFrom"),
        decidedBy: actorHeader(request.headers),
        note: body.note as string | undefined,
      });
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 分类词典版本 ----
  app.put("/taxonomy/:version", async (request, reply) => {
    try {
      const { version } = request.params as { version: string };
      const body = (request.body ?? {}) as JsonBody;
      createTaxonomyVersion(version);
      if (Array.isArray(body.terms)) {
        putTerms(version, body.terms as TermInput[]);
      }
      return reply.status(200).send({ status: "ok", version });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/taxonomy/:version/rules", async (request, reply) => {
    try {
      const { version } = request.params as { version: string };
      const body = request.body as JsonBody;
      if (!Array.isArray(body.rules)) {
        return reply.status(400).send({ error: { code: "INVALID_PAYLOAD", message: "rules 必须为数组" } });
      }
      putRules(version, body.rules as RuleInput[]);
      return reply.status(201).send({ status: "ok" });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 自动归类任务（候选 + 断点续跑） ----
  app.post("/classification/jobs", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as JsonBody;
      const job = createJob(str(body, "taxonomyVersion"), {
        scopeMonth: (body.scopeMonth as string | undefined) ?? null,
      });
      return reply.status(201).send(job);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/classification/jobs/:id/run", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as JsonBody;
      const job = runJob(Number(id), {
        worker:
          (body.worker as string | undefined) ??
          (actorHeader(request.headers) || "worker"),
      });
      return reply.send(job);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/classification/jobs/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return reply.send(getJob(Number(id)));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/candidates", async (request, reply) => {
    const query = request.query as { month?: string; state?: string };
    try {
      return reply.send({ candidates: listCandidates({ month: query.month, state: query.state }) });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/candidates/:id/decision", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as JsonBody;
      const action = body.action;
      if (action !== "confirm" && action !== "reject") {
        return reply.status(400).send({ error: { code: "INVALID_PAYLOAD", message: "action 必须为 confirm/reject" } });
      }
      const candidate = decideCandidate({
        candidateId: Number(id),
        action,
        termCode: (body.termCode as string | null) ?? null,
        decidedBy: actorHeader(request.headers),
      });
      return reply.send(candidate);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 月度发布（锁定口径） ----
  app.post("/publications", async (request, reply) => {
    try {
      const body = request.body as JsonBody;
      const result = publishMonth({
        reportMonth: str(body, "reportMonth"),
        taxonomyVersion: str(body, "taxonomyVersion"),
        publishedBy: actorHeader(request.headers) || str(body, "publishedBy"),
        minSampleThreshold: Number(body.minSampleThreshold ?? 0),
        clientToken: (body.clientToken as string | null) ?? null,
        exclusions: (body.exclusions as { complaintId: number; reason: string }[]) ?? [],
        exclusionRationale: (body.exclusionRationale as Record<string, string>) ?? {},
      });
      return reply.status(result.duplicated ? 200 : 201).send(result);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  // ---- 月报与下钻 ----
  app.get("/reports/:month", async (request, reply) => {
    try {
      const { month } = request.params as { month: string };
      const query = request.query as { version?: string };
      return reply.send(monthlyReport(month, query.version ? Number(query.version) : undefined));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get("/reports/:month/drilldown", async (request, reply) => {
    try {
      const { month } = request.params as { month: string };
      const query = request.query as { merchantRef?: string; termCode?: string; version?: string };
      const userId = actorHeader(request.headers);
      const evidence = drilldown(userId, month, {
        merchantRef: query.merchantRef,
        termCode: query.termCode,
        version: query.version ? Number(query.version) : undefined,
      });
      return reply.send({ evidence });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}

function actorHeader(headers: IncomingHttpHeaders): string {
  const value = headers["x-user-id"];
  return typeof value === "string" ? value : "";
}

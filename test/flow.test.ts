import assert from "node:assert/strict";
import test from "node:test";
import { freshWorld, type World } from "./helpers.js";

const M = "2026-05";

type Resp = { status: number; json: () => any };
type Post = (url: string, body?: unknown, user?: string) => Promise<Resp>;
type Get = (url: string, user?: string) => Promise<Resp>;

interface FlowWorld extends World {
  post: Post;
  get: Get;
}

/** 装配：两个来源、发布人/分析员/查看者、分类版本 v1 */
async function setupWorld(): Promise<FlowWorld> {
  const world = await freshWorld("flow");
  const post: Post = (url, body, user) => world.request({ method: "POST", url, body, user });
  const get: Get = (url, user) => world.request({ method: "GET", url, user });

  for (const [key, name] of [
    ["gov12315", "12315平台"],
    ["appmarket", "应用市场投诉"],
  ]) {
    const r = await post("/admin/sources", { sourceKey: key, displayName: name });
    assert.equal(r.status, 201);
  }
  for (const [userId, displayName, role] of [
    ["pub1", "发布人甲", "publisher"],
    ["ana1", "分析员乙", "analyst"],
    ["viewQ", "质量查看者", "viewer"],
    ["viewNiche", "小众商家查看者", "viewer"],
  ] as const) {
    const r = await post("/admin/users", { userId, displayName, role });
    assert.equal(r.status, 201);
  }
  let r = await world.request({
    method: "PUT",
    url: "/taxonomy/v1",
    body: {
      terms: [
        { code: "Q", label: "质量问题" },
        { code: "L", label: "物流问题" },
      ],
    },
  });
  assert.equal(r.status, 200);
  r = await post("/taxonomy/v1/rules", {
    rules: [
      { matchText: "质量", termCode: "Q", validFrom: "2026-01-01" },
      { matchText: "发货", termCode: "L", validFrom: "2026-01-01" },
    ],
  });
  assert.equal(r.status, 201);

  return Object.assign(world, { post, get });
}

/** 运行归类任务并确认全部未决候选（无建议的显式归到 fallback） */
async function runAndConfirm(w: FlowWorld, month: string, fallback = "Q") {
  let r = await w.post("/classification/jobs", { taxonomyVersion: "v1", scopeMonth: month });
  assert.equal(r.status, 201);
  const jobId = r.json().id;
  r = await w.post(`/classification/jobs/${jobId}/run`, {});
  assert.equal(r.status, 200, "归类任务应完成");
  assert.equal(r.json().state, "completed");
  const pending = (await w.get(`/candidates?month=${month}&state=pending`)).json().candidates as any[];
  for (const candidate of pending) {
    const rr = await w.post(
      `/candidates/${candidate.candidateId}/decision`,
      candidate.proposedTermCode ? { action: "confirm" } : { action: "confirm", termCode: fallback },
      "ana1",
    );
    assert.equal(rr.status, 200);
  }
}

function complaint(ref: string, alias: string, cat: string, day = 8) {
  return {
    sourceRef: ref,
    pseudonym: `P-${ref}`,
    eventTime: `2026-05-${String(day).padStart(2, "0")}`,
    merchantAlias: alias,
    categoryRaw: cat,
    facts: { amount: 100, consumerPhone: "13800000000" },
  };
}

test("重复导入与重复发布不多计一条投诉", async () => {
  const w = await setupWorld();

  const batch = {
    sourceKey: "gov12315",
    batchRef: "b1",
    watermark: 10,
    complaints: [
      complaint("C-1", "星海旗舰店", "质量瑕疵", 3),
      complaint("C-2", "星海旗舰店", "发货延迟", 4),
    ],
  };

  let r = await w.post("/ingest/batches", batch);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json(), { batchId: 1, duplicated: false, importedComplaints: 2, importedWithdrawals: 0 });

  // 完全重复投递：整批幂等
  r = await w.post("/ingest/batches", batch);
  assert.equal(r.status, 200);
  assert.equal(r.json().duplicated, true);
  assert.equal(r.json().importedComplaints, 0);

  // 同一 batch_ref 不同水位：拒绝
  r = await w.post("/ingest/batches", { ...batch, watermark: 11 });
  assert.equal(r.status, 409);
  assert.equal(r.json().error.code, "BATCH_WATERMARK_CONFLICT");

  // 相同水位不同批次号：拒绝
  r = await w.post("/ingest/batches", { ...batch, batchRef: "b1x" });
  assert.equal(r.status, 409);
  assert.equal(r.json().error.code, "BATCH_WATERMARK_CONFLICT");

  await runAndConfirm(w, M);

  const publishBody = { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 0, clientToken: "token-v1" };
  r = await w.post("/publications", publishBody, "pub1");
  assert.equal(r.status, 201);
  assert.equal(r.json().version, 1);
  const first = r.json();

  // clientToken 重复提交：回放同一发布
  r = await w.post("/publications", publishBody, "pub1");
  assert.equal(r.status, 200);
  assert.equal(r.json().publicationId, first.publicationId);

  // 无 token 再发：事实与口径无变化，不产生新版本
  r = await w.post("/publications", { ...publishBody, clientToken: null }, "pub1");
  assert.equal(r.status, 200);
  assert.equal(r.json().version, 1);
  assert.equal(r.json().duplicated, true);

  await w.app.close();
});

test("自动归类可续跑、只产生候选；人工决策不覆盖原始记录", async () => {
  const w = await setupWorld();

  const complaints = Array.from({ length: 250 }, (_, i) =>
    complaint(`R-${i}`, i % 2 ? "星海旗舰店" : "小众海淘", i % 3 === 0 ? "包装破损" : "质量差", 10),
  );
  let r = await w.post("/ingest/batches", { sourceKey: "appmarket", batchRef: "bulk", watermark: 5, complaints });
  assert.equal(r.status, 201);
  assert.equal(r.json().importedComplaints, 250);

  r = await w.post("/classification/jobs", { taxonomyVersion: "v1", scopeMonth: M });
  assert.equal(r.status, 201);
  const jobId = r.json().id;

  r = await w.post(`/classification/jobs/${jobId}/run`, { worker: "worker-1" });
  assert.equal(r.json().state, "completed");
  assert.equal(r.json().processed, 250);

  // 重复运行（进程中断后恢复）：候选不翻倍
  r = await w.post(`/classification/jobs/${jobId}/run`, { worker: "worker-1" });
  assert.equal(r.json().state, "completed");
  assert.equal((await w.get(`/candidates?month=${M}`)).json().candidates.length, 250);

  // 陈旧心跳的 running 任务可被新进程接管，仍不产生重复候选
  r = await w.post("/classification/jobs", { taxonomyVersion: "v1", scopeMonth: M });
  const job2 = r.json().id;
  w.db
    .prepare("UPDATE classification_jobs SET state='running', heartbeat_at=? WHERE id=?")
    .run("2000-01-01 00:00:00", job2);
  r = await w.post(`/classification/jobs/${job2}/run`, { worker: "worker-2" });
  assert.equal(r.json().state, "completed");
  assert.equal((await w.get(`/candidates?month=${M}`)).json().candidates.length, 250);

  const candidates = (await w.get(`/candidates?month=${M}`)).json().candidates as any[];
  const unresolved = candidates.find((c) => c.proposedTermCode === null);
  assert.ok(unresolved, "「包装破损」无规则命中，应存在无法识别候选");
  r = await w.post(`/candidates/${unresolved.candidateId}/decision`, { action: "confirm", termCode: "L" }, "ana1");
  assert.equal(r.status, 200);
  // 重复决策：禁止覆盖
  r = await w.post(`/candidates/${unresolved.candidateId}/decision`, { action: "reject" }, "ana1");
  assert.equal(r.status, 409);
  assert.equal(r.json().error.code, "ALREADY_DECIDED");
  // 原始投诉原文不被改写
  const raw = w.db
    .prepare("SELECT category_raw, merchant_alias_raw FROM complaints WHERE id = ?")
    .get(unresolved.complaintId) as { category_raw: string; merchant_alias_raw: string };
  assert.equal(raw.category_raw, "包装破损");
  assert.equal(raw.merchant_alias_raw, "小众海淘");

  await w.app.close();
});

test("迟到投诉与撤回只产生新版本，月报给出差异来源与未决候选", async () => {
  const w = await setupWorld();

  await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "may-1",
    watermark: 10,
    complaints: [
      complaint("G1", "星海旗舰店", "质量瑕疵"),
      complaint("G2", "星海旗舰店", "质量瑕疵"),
      complaint("G3", "星海旗舰店", "发货延迟"),
      complaint("G4", "星海旗舰店", "发货延迟"),
      complaint("G5", "小众海淘", "质量瑕疵"),
    ],
  });
  await w.post("/ingest/batches", {
    sourceKey: "appmarket",
    batchRef: "may-1",
    watermark: 5,
    complaints: [complaint("A1", "星海朝阳店", "质量瑕疵"), complaint("A2", "星海朝阳店", "质量瑕疵")],
  });

  await w.post("/merchants", { merchantRef: "star", displayPseudonym: "星海连锁" });
  for (const alias of ["星海旗舰店", "星海朝阳店"]) {
    const r = await w.post(
      "/identity/map-alias",
      { alias, targetMerchantRef: "star", validFrom: "2026-01-01", splitFromOpenAuto: true },
      "ana1",
    );
    assert.equal(r.status, 201);
  }

  await runAndConfirm(w, M);

  // v1：阈值 2，G5 所在单元格仅 1 条 → 抑制
  let r = await w.post(
    "/publications",
    { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 2, exclusionRationale: { unclassified: "自动候选不计入" } },
    "pub1",
  );
  assert.equal(r.status, 201);
  let report = (await w.get(`/reports/${M}`)).json();
  assert.equal(report.totals.included, 7);
  const niche = report.cells.find((x: any) => x.merchantRef !== "star");
  assert.equal(niche.suppressed, true);
  assert.equal(niche.count, null, "抑制单元格不得返回真实计数");
  assert.equal(report.cells.find((x: any) => x.merchantRef === "star" && x.termCode === "Q").count, 4);
  assert.equal(report.diff, null, "首版无可比较的上一版");
  assert.deepEqual(
    report.lockedWatermarks.map((x: any) => `${x.sourceKey}:${x.watermark}`).sort(),
    ["appmarket:5", "gov12315:10"],
  );

  // 迟到投诉（更高水位），先不归类
  r = await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "may-late",
    watermark: 11,
    complaints: [complaint("G6", "星海朝阳店", "质量瑕疵", 12)],
  });
  assert.equal(r.status, 201);
  // 撤回随更晚批次单独到达
  r = await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "may-wd",
    watermark: 12,
    withdrawals: [{ complaintRef: "G1", sourceEventRef: "W-G1", eventTime: "2026-05-20" }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.json().importedWithdrawals, 1);
  // 撤回批次重复投递：幂等不多计
  r = await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "may-wd",
    watermark: 12,
    withdrawals: [{ complaintRef: "G1", sourceEventRef: "W-G1", eventTime: "2026-05-20" }],
  });
  assert.equal(r.json().duplicated, true);

  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 2 }, "pub1");
  assert.equal(r.status, 201);
  assert.equal(r.json().version, 2);
  report = (await w.get(`/reports/${M}`)).json();
  assert.equal(report.diff.fromVersion, 1);
  const reasons = report.diff.changedComplaints.map((x: any) => x.reason).sort();
  assert.ok(reasons.includes("withdrawal"), "差异应包含撤回");
  assert.ok(reasons.includes("late_arrival"), "差异应包含迟到");
  const wd = report.diff.changedComplaints.find((x: any) => x.reason === "withdrawal");
  assert.equal(wd.includedBefore, true);
  assert.equal(wd.includedAfter, false);
  assert.equal(report.totals.included, 6, "G1 撤回、G6 未归类");
  assert.ok(report.pendingCandidates.some((x: any) => x.complaintId), "未决候选需呈现");

  // 确认迟到投诉后发布 v3
  await runAndConfirm(w, M);
  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 2 }, "pub1");
  assert.equal(r.json().version, 3);
  report = (await w.get(`/reports/${M}`)).json();
  assert.equal(report.totals.included, 7, "撤回1条、迟到补入1条");
  assert.equal(report.pendingCandidates.length, 0);
  assert.ok(
    report.diff.changedComplaints.some((x: any) => x.reason === "classification_change"),
    "未决转确认应记为 classification_change",
  );

  // 历史版本仍可查看，数字不被改写
  const v1 = (await w.get(`/reports/${M}?version=1`)).json();
  assert.equal(v1.version, 1);
  assert.equal(v1.totals.included, 7);

  // 仅修改小样本阈值（口径变更）也应产生新版本；阈值 5 下全部细分被抑制
  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 5 }, "pub1");
  assert.equal(r.json().version, 4);
  const rep4 = (await w.get(`/reports/${M}`)).json();
  assert.ok(rep4.cells.length > 0);
  assert.ok(rep4.cells.every((x: any) => x.suppressed && x.count === null), "全部单元格抑制且无计数");
  assert.equal(rep4.totals.visibleComplaints, 0);
  // 总数（纳入投诉数）仍可见，但无法下钻到任何细分
  assert.equal(rep4.totals.included, 7);

  await w.app.close();
});

test("身份纠正生成 identity_correction 差异且保留历史区间", async () => {
  const w = await setupWorld();

  await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "b",
    watermark: 10,
    complaints: [complaint("1", "甲店", "质量瑕疵"), complaint("2", "甲店", "质量瑕疵")],
  });
  await w.post("/merchants", { merchantRef: "alpha", displayPseudonym: "甲主体" });
  await w.post("/merchants", { merchantRef: "beta", displayPseudonym: "乙主体" });
  let r = await w.post(
    "/identity/map-alias",
    { alias: "甲店", targetMerchantRef: "alpha", validFrom: "2026-01-01", splitFromOpenAuto: true },
    "ana1",
  );
  assert.equal(r.status, 201);
  r = await w.post(
    "/identity/merge",
    { sourceMerchantRef: "alpha", targetMerchantRef: "beta", validFrom: "2026-01-01" },
    "ana1",
  );
  assert.equal(r.status, 201);
  await runAndConfirm(w, M);

  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 0 }, "pub1");
  assert.equal(r.json().version, 1);
  let report = (await w.get(`/reports/${M}`)).json();
  assert.equal(report.cells[0].merchantRef, "beta", "合并后归到 beta");

  // 纠错：alpha 应独立为 gamma，旧合并区间在 2026-05-01 关闭
  await w.post("/merchants", { merchantRef: "gamma", displayPseudonym: "丙主体" });
  r = await w.post(
    "/identity/correct-merge",
    { sourceMerchantRef: "alpha", newTargetMerchantRef: "gamma", validFrom: "2026-05-01", note: "纠错" },
    "ana1",
  );
  assert.equal(r.status, 201);
  // 对从未合并过的商家执行纠错：报 MERGE_NOT_FOUND
  r = await w.post(
    "/identity/correct-merge",
    { sourceMerchantRef: "gamma", newTargetMerchantRef: "beta", validFrom: "2026-06-01" },
    "ana1",
  );
  assert.equal(r.status, 404);
  assert.equal(r.json().error.code, "MERGE_NOT_FOUND");

  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 0 }, "pub1");
  assert.equal(r.json().version, 2);
  report = (await w.get(`/reports/${M}`)).json();
  const corrections = report.diff.changedComplaints.filter((x: any) => x.reason === "identity_correction");
  assert.equal(corrections.length, 2, "两条投诉都应标注身份纠正");
  assert.ok(report.cells.some((x: any) => x.merchantRef === "gamma"));

  const merges = w.db
    .prepare(
      "SELECT valid_to FROM merchant_merges WHERE source_merchant_id = (SELECT id FROM merchants WHERE merchant_ref='alpha') ORDER BY id",
    )
    .all() as { valid_to: string | null }[];
  assert.equal(merges.length, 2, "旧区间保留、新区间追加");
  assert.equal(merges[0].valid_to, "2026-05-01");
  assert.equal(merges[1].valid_to, null);

  await w.app.close();
});

test("查看者下钻受范围限制、证据去标识化，小样本不暴露成员", async () => {
  const w = await setupWorld();

  await w.post("/ingest/batches", {
    sourceKey: "gov12315",
    batchRef: "b",
    watermark: 10,
    complaints: [
      complaint("Q1", "星海旗舰店", "质量瑕疵"),
      complaint("Q2", "星海旗舰店", "质量瑕疵"),
      complaint("L1", "星海旗舰店", "发货延迟"),
    ],
  });
  await w.post("/merchants", { merchantRef: "star", displayPseudonym: "星海连锁" });
  await w.post(
    "/identity/map-alias",
    { alias: "星海旗舰店", targetMerchantRef: "star", validFrom: "2026-01-01", splitFromOpenAuto: true },
    "ana1",
  );
  await runAndConfirm(w, M);
  await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 0 }, "pub1");

  // viewQ 仅有 Q 分类授权：看 L 被拒
  let r = await w.post("/admin/users/viewQ/scopes", { dimension: "category", scopeValue: "Q" });
  assert.equal(r.status, 201);
  r = await w.get(`/reports/${M}/drilldown?termCode=L`, "viewQ");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "FORBIDDEN_SCOPE");

  r = await w.get(`/reports/${M}/drilldown?termCode=Q`, "viewQ");
  assert.equal(r.status, 200);
  const evidence = r.json().evidence as any[];
  assert.equal(evidence.length, 2);
  for (const row of evidence) {
    assert.equal(row.termCode, "Q");
    assert.equal(row.facts.consumerPhone, undefined, "手机号必须剥离");
    assert.equal(row.facts.amount, 100, "非敏感事实保留");
    assert.ok(!("merchantAlias" in row), "证据不得含来报别名原文");
    assert.ok(typeof row.pseudonym === "string" && row.pseudonym.startsWith("P-"));
  }

  // 无授权的分析员同样被拒（范围不随角色放大）
  r = await w.get(`/reports/${M}/drilldown?termCode=Q`, "ana1");
  assert.equal(r.status, 403);
  // 非发布人不能锁定发布
  r = await w.post("/publications", { reportMonth: M, taxonomyVersion: "v1", minSampleThreshold: 0 }, "ana1");
  assert.equal(r.status, 403);

  // 6 月小样本（1 条，阈值 5）：单元格抑制且下钻无成员
  const june = {
    sourceRef: "N1",
    pseudonym: "P-N1",
    eventTime: "2026-06-02",
    merchantAlias: "小众海淘",
    categoryRaw: "质量瑕疵",
  };
  await w.post("/ingest/batches", { sourceKey: "gov12315", batchRef: "jun", watermark: 20, complaints: [june] });
  await w.post("/admin/users/viewNiche/scopes", { dimension: "category", scopeValue: "Q" });
  await runAndConfirm(w, "2026-06");
  await w.post("/publications", { reportMonth: "2026-06", taxonomyVersion: "v1", minSampleThreshold: 5 }, "pub1");
  const juneReport = (await w.get("/reports/2026-06")).json();
  assert.equal(juneReport.cells[0].suppressed, true);
  r = await w.get("/reports/2026-06/drilldown?termCode=Q", "viewNiche");
  assert.equal(r.status, 200);
  assert.equal(r.json().evidence.length, 0, "被抑制单元格不得暴露成员");

  await w.app.close();
});

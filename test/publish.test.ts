import assert from "node:assert/strict";
import test from "node:test";

import { importBatchOnce, seedSource, seedTaxonomy, setupApp } from "./helpers.js";

async function classifyAll(app: ReturnType<typeof import("../src/app.js").buildApp>, ruleVersion: string) {
  const run = await app.inject({
    method: "POST",
    url: "/classification/runs",
    payload: { rule_version: ruleVersion, taxonomy_version: "tax-v1" },
  });
  const runId = run.json().run_id;
  for (let i = 0; i < 10; i += 1) {
    const advanced = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    if (advanced.status === "completed") break;
  }
  const candidates = (
    await app.inject({ method: "GET", url: "/classification/candidates?pending=true" })
  ).json().candidates as Array<{ candidate_id: number }>;
  for (const candidate of candidates) {
    const response = await app.inject({
      method: "POST",
      url: `/classification/candidates/${candidate.candidate_id}/decisions`,
      payload: { action: "confirm", actor: "analyst-1" },
    });
    assert.equal(response.statusCode, 201);
  }
}

async function publish(app: ReturnType<typeof import("../src/app.js").buildApp>, requestKey: string) {
  return app.inject({
    method: "POST",
    url: "/reports/2026-08/publish",
    payload: {
      taxonomy_version: "tax-v1",
      published_by: "publisher-1",
      exclusion_reasons: ["重复投诉已剔除"],
      request_key: requestKey,
    },
  });
}

test("发布锁定口径并冻结快照，迟到事实只进入新版本，重复发布不多计", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedSource(app);
    await seedTaxonomy(app);
    for (const [alias, merchant] of [
      ["店铺A", "M_A"],
      ["店铺B", "M_B"],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/merchant-identities",
        payload: { alias, merchant_key: merchant, valid_from: "2026-01" },
      });
      assert.equal(response.statusCode, 201);
    }
    await importBatchOnce(app, "src-a", "b1", "0100", [
      { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "用户申请退款未处理" },
      { source_event_id: "e2", cursor: "0002", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款被拒" },
      { source_event_id: "e3", cursor: "0003", complaint_month: "2026-08", merchant_alias: "店铺B", detail: "物流迟迟不到" },
      { source_event_id: "e4", cursor: "0004", complaint_month: "2026-07", merchant_alias: "店铺A", detail: "退款" },
    ]);
    await classifyAll(app, "r1");

    // 第一次发布：锁定水位 0100
    const first = await publish(app, "rk-1");
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().publication.version_no, 1);
    assert.deepEqual(first.json().publication.source_watermark, { "src-a": "0100" });

    let report = (await app.inject({ method: "GET", url: "/reports/2026-08" })).json();
    assert.equal(report.totals.complaints, 3);
    assert.equal(report.pending_candidates, 0);
    assert.equal(report.diff.compared_to_version, null);
    const refundCellV1 = report.cells.find((c: Record<string, unknown>) => c.category_key === "REFUND");
    assert.deepEqual(
      { merchant: refundCellV1.merchant_key, count: refundCellV1.count, suppressed: refundCellV1.suppressed },
      { merchant: "M_A", count: 2, suppressed: false },
    );
    const logisticsCellV1 = report.cells.find((c: Record<string, unknown>) => c.category_key === "LOGISTICS");
    assert.equal(logisticsCellV1.suppressed, true);
    assert.equal(logisticsCellV1.count, null);

    // 迟到投诉、撤回与身份纠正到达
    await importBatchOnce(
      app,
      "src-a",
      "b2",
      "0200",
      [{ source_event_id: "e5", cursor: "0005", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款问题再次出现" }],
      [{ source_event_id: "e1", cursor: "0006", reason: "用户撤销" }],
    );
    await app.inject({
      method: "POST",
      url: "/merchant-identities",
      payload: { alias: "店铺A", merchant_key: "M_A2", valid_from: "2026-08" },
    });
    const rerun = await app.inject({
      method: "POST",
      url: "/classification/runs",
      payload: { rule_version: "r1", taxonomy_version: "tax-v1" },
    });
    await app.inject({ method: "POST", url: `/classification/runs/${rerun.json().run_id}/advance` });

    // 未决候选在月报上可见
    report = (await app.inject({ method: "GET", url: "/reports/2026-08" })).json();
    assert.equal(report.pending_candidates, 1);
    await classifyAll(app, "r1");

    // 第二次发布：版本 2，差异来源可归因
    const second = await publish(app, "rk-2");
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().publication.version_no, 2);
    assert.deepEqual(second.json().publication.source_watermark, { "src-a": "0200" });

    report = (await app.inject({ method: "GET", url: "/reports/2026-08" })).json();
    assert.equal(report.publication.version_no, 2);
    assert.equal(report.totals.complaints, 3);
    assert.deepEqual(report.diff, {
      compared_to_version: 1,
      added: 1,
      withdrawn: 1,
      merged: 0,
      identity_changed: 1,
      category_changed: 0,
    });
    const refundCellV2 = report.cells.find((c: Record<string, unknown>) => c.category_key === "REFUND");
    assert.equal(refundCellV2.merchant_key, "M_A2");
    assert.equal(refundCellV2.count, 2);

    // 相同 request_key 重复发布：返回首次结果，不产生新版本
    const republish = await publish(app, "rk-2");
    assert.equal(republish.statusCode, 200);
    assert.equal(republish.json().replayed, true);
    report = (await app.inject({ method: "GET", url: "/reports/2026-08" })).json();
    assert.equal(report.publication.version_no, 2);
    assert.equal(report.totals.complaints, 3);
  } finally {
    await cleanup();
  }
});

test("下钻限于职责范围且抑制小样本单元", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedSource(app);
    await seedTaxonomy(app);
    await app.inject({
      method: "POST",
      url: "/merchant-identities",
      payload: { alias: "店铺A", merchant_key: "M_A", valid_from: "2026-01" },
    });
    await importBatchOnce(app, "src-a", "b1", "0100", [
      { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款问题一" },
      { source_event_id: "e2", cursor: "0002", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款问题二" },
      { source_event_id: "e3", cursor: "0003", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "物流问题一" },
    ]);
    await classifyAll(app, "r1");
    await publish(app, "rk-1");

    // 缺少身份头
    let response = await app.inject({
      method: "GET",
      url: "/reports/2026-08/drilldown?category_key=REFUND&merchant_key=M_A",
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "ACTOR_REQUIRED");

    // 无职责范围
    response = await app.inject({
      method: "GET",
      url: "/reports/2026-08/drilldown?category_key=REFUND&merchant_key=M_A",
      headers: { "x-actor": "viewer-1" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "SCOPE_DENIED");

    // 授予 REFUND 类别范围后可下钻，证据为去标识化投影
    await app.inject({
      method: "PUT",
      url: "/viewers/viewer-1/scopes",
      payload: { scopes: [{ scope_type: "category", scope_value: "REFUND" }] },
    });
    response = await app.inject({
      method: "GET",
      url: "/reports/2026-08/drilldown?category_key=REFUND&merchant_key=M_A",
      headers: { "x-actor": "viewer-1" },
    });
    assert.equal(response.statusCode, 200);
    const events = response.json().events;
    assert.equal(events.length, 2);
    assert.ok(events.every((e: Record<string, unknown>) => typeof e.event_ref === "string"));
    assert.ok(events.every((e: Record<string, unknown>) => !("source_event_id" in e) && !("merchant_alias" in e)));

    // 超出职责范围的类别被拒绝
    response = await app.inject({
      method: "GET",
      url: "/reports/2026-08/drilldown?category_key=LOGISTICS&merchant_key=M_A",
      headers: { "x-actor": "viewer-1" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "SCOPE_DENIED");

    // 样本过少的单元被抑制，即使通配范围也不可下钻
    await app.inject({
      method: "PUT",
      url: "/viewers/viewer-2/scopes",
      payload: { scopes: [{ scope_type: "category", scope_value: "*" }] },
    });
    response = await app.inject({
      method: "GET",
      url: "/reports/2026-08/drilldown?category_key=LOGISTICS&merchant_key=M_A",
      headers: { "x-actor": "viewer-2" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "CELL_SUPPRESSED");
  } finally {
    await cleanup();
  }
});

test("未发布月份与未知词典版本的错误码稳定", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const missing = await app.inject({ method: "GET", url: "/reports/2026-08" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "PUBLICATION_NOT_FOUND");

    await seedTaxonomy(app);
    const badTaxonomy = await app.inject({
      method: "POST",
      url: "/reports/2026-08/publish",
      payload: { taxonomy_version: "nope", published_by: "p" },
    });
    assert.equal(badTaxonomy.statusCode, 404);
    assert.equal(badTaxonomy.json().error.code, "TAXONOMY_VERSION_NOT_FOUND");
  } finally {
    await cleanup();
  }
});

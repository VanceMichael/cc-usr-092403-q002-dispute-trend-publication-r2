import assert from "node:assert/strict";
import test from "node:test";

import { importBatchOnce, seedSource, seedTaxonomy, setupApp } from "./helpers.js";

async function seedEvents(app: ReturnType<typeof import("../src/app.js").buildApp>) {
  await seedSource(app);
  await seedTaxonomy(app);
  await importBatchOnce(app, "src-a", "b1", "0100", [
    { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "用户申请退款未处理" },
    { source_event_id: "e2", cursor: "0002", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款被拒" },
    { source_event_id: "e3", cursor: "0003", complaint_month: "2026-08", merchant_alias: "店铺B", detail: "物流迟迟不到" },
  ]);
}

async function candidatesOf(app: ReturnType<typeof import("../src/app.js").buildApp>, query = "") {
  const response = await app.inject({ method: "GET", url: `/classification/candidates${query}` });
  return response.json().candidates as Array<Record<string, unknown>>;
}

test("归类作业分页推进，中断后从检查点继续且候选不重复", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedEvents(app);
    const created = await app.inject({
      method: "POST",
      url: "/classification/runs",
      payload: { rule_version: "r1", taxonomy_version: "tax-v1", page_size: 1 },
    });
    const runId = created.json().run_id;

    // 每页一条，逐页推进模拟可中断的进度
    let run = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    assert.equal(run.status, "running");
    assert.equal(run.processed_total, 1);
    const checkpointAfterFirstPage = run.checkpoint;

    run = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    assert.equal(run.processed_total, 2);
    assert.ok(run.checkpoint > checkpointAfterFirstPage);

    run = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    run = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    assert.equal(run.status, "completed");
    assert.equal(run.processed_total, 3);

    const firstPass = await candidatesOf(app);
    assert.equal(firstPass.length, 3);

    // 已完成的作业不再推进；新作业重扫同样的事件也不会多产候选
    const again = (await app.inject({ method: "POST", url: `/classification/runs/${runId}/advance` })).json();
    assert.equal(again.status, "completed");
    const rerun = await app.inject({
      method: "POST",
      url: "/classification/runs",
      payload: { rule_version: "r1", taxonomy_version: "tax-v1" },
    });
    await app.inject({ method: "POST", url: `/classification/runs/${rerun.json().run_id}/advance` });
    assert.equal((await candidatesOf(app)).length, 3);
  } finally {
    await cleanup();
  }
});

test("人工确认、拆分、合并只追加处置，不覆盖候选与历史处置", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedEvents(app);
    const run = await app.inject({
      method: "POST",
      url: "/classification/runs",
      payload: { rule_version: "r1", taxonomy_version: "tax-v1" },
    });
    await app.inject({ method: "POST", url: `/classification/runs/${run.json().run_id}/advance` });
    const candidates = await candidatesOf(app);
    const byEvent = new Map(candidates.map((c) => [c.event_id, c]));
    const e1 = [...byEvent.values()].find((c) => c.category_key === "REFUND")!;

    // 确认
    const confirm = await app.inject({
      method: "POST",
      url: `/classification/candidates/${e1.candidate_id}/decisions`,
      payload: { action: "confirm", actor: "analyst-1" },
    });
    assert.equal(confirm.statusCode, 201);

    // 拆分：同一候选再追加一条 split 处置，候选本身不被修改
    const split = await app.inject({
      method: "POST",
      url: `/classification/candidates/${e1.candidate_id}/decisions`,
      payload: { action: "split", actor: "analyst-2", detail: { categories: ["REFUND", "LOGISTICS"] } },
    });
    assert.equal(split.statusCode, 201);

    const decisions = (
      await app.inject({ method: "GET", url: `/classification/candidates/${e1.candidate_id}/decisions` })
    ).json().decisions;
    assert.equal(decisions.length, 2);
    assert.deepEqual(
      decisions.map((d: Record<string, unknown>) => d.action),
      ["confirm", "split"],
    );

    // 候选记录保持原样
    const stillThere = (await candidatesOf(app)).find((c) => c.candidate_id === e1.candidate_id)!;
    assert.equal(stillThere.category_key, "REFUND");
    assert.equal(stillThere.decided, 1);

    // 合并处置需要 canonical_event_id
    const merge = await app.inject({
      method: "POST",
      url: `/classification/candidates/${e1.candidate_id}/decisions`,
      payload: { action: "merge", actor: "analyst-1", detail: { canonical_event_id: 2 } },
    });
    assert.equal(merge.statusCode, 201);
    const badMerge = await app.inject({
      method: "POST",
      url: `/classification/candidates/${e1.candidate_id}/decisions`,
      payload: { action: "merge", actor: "analyst-1", detail: {} },
    });
    assert.equal(badMerge.statusCode, 400);
    assert.equal(badMerge.json().error.code, "VALIDATION_FAILED");

    // 未决候选查询：该候选已有处置，不再未决
    const pending = await candidatesOf(app, "?pending=true&month=2026-08");
    assert.ok(pending.every((c) => c.candidate_id !== e1.candidate_id));
    assert.equal(pending.length, 2);
  } finally {
    await cleanup();
  }
});

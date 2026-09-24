import assert from "node:assert/strict";
import test from "node:test";

import { importBatchOnce, seedSource, setupApp } from "./helpers.js";

test("批次导入按业务水位去重，重放与重复事件不多计", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedSource(app);

    const first = await importBatchOnce(app, "src-a", "b1", "0100", [
      { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "用户申请退款未处理" },
      { source_event_id: "e2", cursor: "0002", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款被拒" },
      { source_event_id: "e3", cursor: "0003", complaint_month: "2026-08", merchant_alias: "店铺B", detail: "物流迟迟不到" },
    ]);
    assert.equal(first.replayed, false);
    assert.equal(first.accepted_events, 3);
    assert.equal(first.duplicate_events, 0);

    // 同一批次键重放：返回首次结果，不重复接收
    const replay = await importBatchOnce(app, "src-a", "b1", "0100", [
      { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "用户申请退款未处理" },
    ]);
    assert.equal(replay.replayed, true);
    assert.equal(replay.accepted_events, 3);

    // 新批次含已收事件：按业务键去重，只接收新事件
    const second = await importBatchOnce(app, "src-a", "b2", "0200", [
      { source_event_id: "e2", cursor: "0002", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款被拒" },
      { source_event_id: "e4", cursor: "0004", complaint_month: "2026-08", merchant_alias: "店铺B", detail: "物流破损" },
    ]);
    assert.equal(second.accepted_events, 1);
    assert.equal(second.duplicate_events, 1);

    const source = (await app.inject({ method: "GET", url: "/sources/src-a" })).json();
    assert.equal(source.watermark, "0200");

    // 水位只升不降：迟到批次水位较低时水位不回退
    await importBatchOnce(app, "src-a", "b3", "0050", []);
    const after = (await app.inject({ method: "GET", url: "/sources/src-a" })).json();
    assert.equal(after.watermark, "0200");
  } finally {
    await cleanup();
  }
});

test("撤回记录幂等接收，同一投诉重复撤回只记一次", async () => {
  const { app, cleanup } = await setupApp();
  try {
    await seedSource(app);
    await importBatchOnce(app, "src-a", "b1", "0100", [
      { source_event_id: "e1", cursor: "0001", complaint_month: "2026-08", merchant_alias: "店铺A", detail: "退款" },
    ]);
    const result = await importBatchOnce(
      app,
      "src-a",
      "b2",
      "0200",
      [],
      [
        { source_event_id: "e1", cursor: "0005", reason: "用户撤销" },
        { source_event_id: "e1", cursor: "0006", reason: "用户撤销" },
      ],
    );
    assert.equal(result.accepted_withdrawals, 1);
    assert.equal(result.duplicate_withdrawals, 1);
  } finally {
    await cleanup();
  }
});

test("未登记来源导入被拒绝，错误码稳定", async () => {
  const { app, cleanup } = await setupApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/sources/ghost/batches",
      payload: { batch_key: "b1", watermark: "0001", events: [] },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "SOURCE_NOT_FOUND");
  } finally {
    await cleanup();
  }
});

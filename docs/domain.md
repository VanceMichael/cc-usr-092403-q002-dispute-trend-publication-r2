# 消费争议数据约定

系统只保存完成争议分析所需的去标识化事实。来源事件、分类口径、商家身份映射和报告修订分别维护版本，已发布报告引用固定的数据水位。接口错误使用稳定的机器可读代码，所有持久状态进入同一 SQLite 文件。

## 趋势口径发布流程

### 接收：按业务水位幂等去重

- 每个来源在 `source_registry` 登记；批次写入 `source_batches`，`(source_key, batch_ref)` 与 `(source_key, watermark)` 双唯一。
- 同一 `batch_ref` 重复投递整批回放（`duplicated=true`），绝不重复插入投诉或撤回；批次号相同但水位/内容指纹不一致返回 `BATCH_WATERMARK_CONFLICT` / `BATCH_CONTENT_CONFLICT`。
- 投诉 `(source_key, source_ref)` 唯一；撤回是 `complaint_events` 中的独立事件，可随更高水位批次单独（迟到）到达，`(complaint_id, event_type)` 唯一保证不重复生效。

### 身份与词典：有效区间，不覆盖原始事实

- `complaints` 只追加：来报别名 `merchant_alias_raw`、来报分类 `category_raw` 永不被任何决策改写。
- 商家别名映射 `merchant_aliases` 带 `[valid_from, valid_to)` 区间；首次见到的别名自动建区间，人工拆分（`map-alias` + `splitFromOpenAuto`）切分或作废 auto 区间。
- 商家合并 `merchant_merges` 同样是区间事实；身份纠正（`correct-merge`）关闭旧开放区间并追加新区间，历史区间保留，旧版发布仍按当时区间解析。
- 分类词典按 `taxonomy_versions` 版本化，词条下的匹配规则 `taxonomy_rules` 带有效区间，区间重叠返回 `RULE_RANGE_OVERLAP`。

### 归类：自动只产生候选，人工独立决策，任务可续跑

- 自动归类写入 `classification_candidates`（每投诉每版本唯一），状态机 `pending → confirmed|rejected`；人工确认可改用其他词条，重复决策返回 `ALREADY_DECIDED`。
- `classification_jobs` 以 `cursor_id` 为游标分批推进并刷新心跳；进程中断后重跑从游标继续，心跳超时（默认 30s）的 running 任务可被新进程接管。候选 upsert 保证续跑不产生重复候选。
- 只有 `confirmed` 的投诉进入正式发布数字；自动建议与待决候选一律排除（理由 `unclassified`）。

### 发布：锁定口径，变化只产生新比较版本

- 发布人锁定：各来源当前水位（`publication_source_watermarks`）、分类版本、小样本阈值、排除理由（`exclusion_rationale_json`）与逐条排除（撤回自动、人工另附）。
- 每次发布生成不可变快照 `publication_complaints`（含解析后的商家/词条与相对上一版的 `change_reason`）与聚合 `publication_cells`；旧版置为 `superseded`。
- 差异来源：`late_arrival`（迟到投诉）、`withdrawal`（撤回）、`identity_correction`（身份纠正）、`classification_change`（人工归类变化）、`exclusion_change`（排除变化）。
- 幂等：相同 `client_token` 回放同一发布；事实与口径指纹（含水印、阈值、逐条解析结果）无变化时重复发布不产生新版本。

### 小样本抑制与下钻授权

- 单元格投诉数 `< min_sample_threshold` 标记 `suppressed`：月报不返回真实计数，版本差异对抑制单元格同样遮蔽计数，下钻不返回其成员。
- 查看者授权见 `viewer_scopes`（merchant/category/all）；下钻先校验职责范围（`FORBIDDEN_SCOPE`，范围不随角色放大），证据只含假名、日期与 `facts` 中的去标识化字段（手机号、证件、地址等键被剥离）。

### 月报接口

`GET /reports/:month[?version=n]` 同时返回：当期单元格数字与抑制标记、合计、锁定水位、相对上一发布版的差异来源与计数变化、以及锁定水位内尚未确认的未决候选（含尚无候选行的迟到投诉）。

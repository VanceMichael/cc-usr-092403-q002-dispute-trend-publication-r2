-- 趋势口径发布流程：批次水位、去标识化事件、有效区间、归类候选与发布快照。
-- 所有事实表只追加，不更新业务字段；口径变化通过新行/新版本表达。

-- 来源批次：同一 (source_key, batch_key) 只接收一次，重放返回首次结果。
CREATE TABLE IF NOT EXISTS source_batches (
  batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL REFERENCES source_registry(source_key),
  batch_key TEXT NOT NULL,
  watermark TEXT NOT NULL,
  accepted_events INTEGER NOT NULL DEFAULT 0,
  duplicate_events INTEGER NOT NULL DEFAULT 0,
  accepted_withdrawals INTEGER NOT NULL DEFAULT 0,
  duplicate_withdrawals INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_key, batch_key)
);

-- 每个来源已接收的最高业务水位（游标按字典序比较，来源需保证可排序，如零填充序号或 ISO 时间）。
CREATE TABLE IF NOT EXISTS source_watermarks (
  source_key TEXT PRIMARY KEY REFERENCES source_registry(source_key),
  watermark TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 投诉事件：去标识化事实，(source_key, source_event_id) 幂等去重。
CREATE TABLE IF NOT EXISTS complaint_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL REFERENCES source_registry(source_key),
  source_event_id TEXT NOT NULL,
  business_cursor TEXT NOT NULL,
  complaint_month TEXT NOT NULL,
  merchant_alias TEXT NOT NULL,
  detail TEXT NOT NULL,
  batch_id INTEGER NOT NULL REFERENCES source_batches(batch_id),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_key, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_complaint_events_month ON complaint_events(complaint_month);

-- 撤回记录：只追加，同一投诉的撤回只记一次。
CREATE TABLE IF NOT EXISTS withdrawal_events (
  withdrawal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  business_cursor TEXT NOT NULL,
  reason TEXT,
  batch_id INTEGER NOT NULL REFERENCES source_batches(batch_id),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_key, source_event_id)
);

-- 商家身份合并：有效区间 [valid_from, valid_to)，纠正只追加新区间，不改历史行。
CREATE TABLE IF NOT EXISTS merchant_identity_map (
  map_id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_identity_map_alias ON merchant_identity_map(alias, valid_from);

-- 分类词典版本：版本一旦创建不可变，类别带有效区间。
CREATE TABLE IF NOT EXISTS taxonomy_versions (
  version_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxonomy_categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_key TEXT NOT NULL REFERENCES taxonomy_versions(version_key),
  category_key TEXT NOT NULL,
  label TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  UNIQUE (version_key, category_key)
);

-- 归类作业：checkpoint 记录已处理到的 event_id，中断后从检查点继续。
CREATE TABLE IF NOT EXISTS classification_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_version TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL REFERENCES taxonomy_versions(version_key),
  page_size INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'pending',
  checkpoint INTEGER NOT NULL DEFAULT 0,
  processed_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 自动归类候选：只由规则生成，人工处置不修改本表。
CREATE TABLE IF NOT EXISTS classification_candidates (
  candidate_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES complaint_events(event_id),
  run_id INTEGER NOT NULL REFERENCES classification_runs(run_id),
  rule_version TEXT NOT NULL,
  category_key TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, rule_version, category_key)
);

-- 人工处置：只追加。split 的 detail.categories 为拆分出的类别数组；
-- merge 的 detail.canonical_event_id 指向合并后保留的事件。
CREATE TABLE IF NOT EXISTS classification_decisions (
  decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES classification_candidates(candidate_id),
  action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'split', 'merge')),
  detail TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_decisions_candidate ON classification_decisions(candidate_id, decision_id);

-- 发布版本：锁定某月的来源水位、分类版本与排除理由；request_key 供幂等重发。
CREATE TABLE IF NOT EXISTS report_publications (
  publication_id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  request_key TEXT,
  source_watermark TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL REFERENCES taxonomy_versions(version_key),
  exclusion_reasons TEXT NOT NULL DEFAULT '[]',
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (month, version_no),
  UNIQUE (month, request_key)
);

-- 发布快照：冻结当期计入的事件及其口径（类别、归并商家），之后的事实变化只影响新版本。
-- 一个事件拆分后可有多个类别行；投诉总量按 DISTINCT event_id 计，不多计。
CREATE TABLE IF NOT EXISTS publication_events (
  publication_id INTEGER NOT NULL REFERENCES report_publications(publication_id),
  event_id INTEGER NOT NULL,
  category_key TEXT NOT NULL,
  merchant_key TEXT NOT NULL,
  PRIMARY KEY (publication_id, event_id, category_key)
);

-- 查看者职责范围：scope_value 为类别键或 '*' 通配。
CREATE TABLE IF NOT EXISTS viewer_scopes (
  actor TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('category')),
  scope_value TEXT NOT NULL,
  PRIMARY KEY (actor, scope_type, scope_value)
);

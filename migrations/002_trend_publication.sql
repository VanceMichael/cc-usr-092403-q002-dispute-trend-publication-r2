-- 趋势口径发布流程：批次水位、有效区间身份/词典、候选与人工决策、发布快照与下钻授权

-- 1. 来源批次：同一来源按业务水位（watermark）与业务批次号去重
CREATE TABLE IF NOT EXISTS source_batches (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL,
  batch_ref TEXT NOT NULL,              -- 来源侧业务批次号，重复投递据此识别
  watermark INTEGER NOT NULL,           -- 来源内单调递增的业务水位
  content_hash TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_key, batch_ref),
  UNIQUE(source_key, watermark),
  FOREIGN KEY(source_key) REFERENCES source_registry(source_key)
);

-- 投诉原始记录（去标识化事实，只追加，任何决策都不覆盖本表）
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_ref TEXT NOT NULL,             -- 来源侧投诉业务号
  pseudonym TEXT NOT NULL,              -- 对外展示的去标识化名
  registered_batch_id INTEGER NOT NULL,
  event_time TEXT NOT NULL,             -- 争议发生日期 YYYY-MM-DD
  complaint_month TEXT NOT NULL,        -- YYYY-MM
  merchant_alias_raw TEXT NOT NULL,     -- 来报商家别名原文（不可变）
  category_raw TEXT NOT NULL,           -- 来报问题分类原文（不可变）
  facts_json TEXT NOT NULL DEFAULT '{}',-- 仅允许去标识化事实
  auto_classified_at TEXT,              -- 自动归类续跑断点：已处理标记
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_key, source_ref),
  FOREIGN KEY(registered_batch_id) REFERENCES source_batches(id)
);
CREATE INDEX IF NOT EXISTS idx_complaints_month ON complaints(complaint_month, id);

-- 投诉生命周期事件（当前只有撤回；幂等键为批次内事件号）
CREATE TABLE IF NOT EXISTS complaint_events (
  id INTEGER PRIMARY KEY,
  complaint_id INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  source_event_ref TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('withdrawn')),
  event_time TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, source_event_ref),
  UNIQUE(complaint_id, event_type),     -- 一条投诉至多一条生效撤回
  FOREIGN KEY(complaint_id) REFERENCES complaints(id),
  FOREIGN KEY(batch_id) REFERENCES source_batches(id)
);

-- 2. 商家身份：规范商家 + 带有效区间的别名映射（自动/人工决策分层）
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY,
  merchant_ref TEXT NOT NULL UNIQUE,    -- 业务稳定标识
  display_pseudonym TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 合并关系也是带有效区间的事实：纠正合并 = 关闭旧区间并追加新区间
CREATE TABLE IF NOT EXISTS merchant_merges (
  id INTEGER PRIMARY KEY,
  source_merchant_id INTEGER NOT NULL,
  target_merchant_id INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  decided_by TEXT NOT NULL,
  decision_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(valid_to IS NULL OR valid_to > valid_from),
  CHECK(source_merchant_id <> target_merchant_id),
  FOREIGN KEY(source_merchant_id) REFERENCES merchants(id),
  FOREIGN KEY(target_merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_merges_source ON merchant_merges(source_merchant_id, valid_from);

CREATE TABLE IF NOT EXISTS merchant_aliases (
  id INTEGER PRIMARY KEY,
  alias_value TEXT NOT NULL,
  merchant_id INTEGER NOT NULL,
  valid_from TEXT NOT NULL,             -- 含，YYYY-MM-DD
  valid_to TEXT,                        -- 不含，NULL 表示至今
  decided_by TEXT NOT NULL,             -- auto | manual:<user_id>
  decision_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(valid_to IS NULL OR valid_to > valid_from),
  FOREIGN KEY(merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_aliases_value ON merchant_aliases(alias_value);

CREATE TABLE IF NOT EXISTS identity_decisions (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('map','merge','split')),
  alias_value TEXT,
  source_merchant_ref TEXT,
  target_merchant_ref TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  decided_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. 分类词典：版本 + 词条 + 带有效区间的归类规则
CREATE TABLE IF NOT EXISTS taxonomy_versions (
  version TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxonomy_terms (
  version TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  parent_code TEXT,
  PRIMARY KEY(version, code),
  FOREIGN KEY(version) REFERENCES taxonomy_versions(version)
);

CREATE TABLE IF NOT EXISTS taxonomy_rules (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL,
  match_text TEXT NOT NULL COLLATE NOCASE,
  term_code TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  CHECK(valid_to IS NULL OR valid_to > valid_from),
  FOREIGN KEY(version) REFERENCES taxonomy_versions(version),
  FOREIGN KEY(version, term_code) REFERENCES taxonomy_terms(version, code)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_rules_match ON taxonomy_rules(version, match_text);

-- 4. 自动归类只产生候选；人工确认/否决另存决策字段，不回写原始记录
CREATE TABLE IF NOT EXISTS classification_candidates (
  id INTEGER PRIMARY KEY,
  complaint_id INTEGER NOT NULL,
  taxonomy_version TEXT NOT NULL,
  proposed_term_code TEXT,              -- 自动建议，可能为空（无法识别）
  method TEXT NOT NULL DEFAULT 'auto',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','confirmed','rejected')),
  confirmed_term_code TEXT,             -- 人工确认的口径（可与建议不同）
  decided_by TEXT,
  decided_at TEXT,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(complaint_id, taxonomy_version),
  FOREIGN KEY(complaint_id) REFERENCES complaints(id),
  FOREIGN KEY(taxonomy_version) REFERENCES taxonomy_versions(version)
);

-- 归类任务：游标+心跳，进程中断后从未处理投诉继续
CREATE TABLE IF NOT EXISTS classification_jobs (
  id INTEGER PRIMARY KEY,
  taxonomy_version TEXT NOT NULL,
  scope_month TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','running','completed','interrupted','failed')),
  cursor_id INTEGER NOT NULL DEFAULT 0, -- 已处理到的 complaints.id
  total INTEGER,
  processed INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(taxonomy_version) REFERENCES taxonomy_versions(version)
);

-- 5. 月度发布：锁定来源水位、分类版本、排除理由；每版一份不可变快照
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY,
  report_month TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'current' CHECK(status IN ('current','superseded')),
  taxonomy_version TEXT NOT NULL,
  min_sample_threshold INTEGER NOT NULL,
  published_by TEXT NOT NULL,
  client_token TEXT,                    -- 重复发布幂等键
  fingerprint TEXT NOT NULL,            -- 快照口径指纹，相同指纹不产生新版本
  exclusion_rationale_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(report_month, version),
  UNIQUE(client_token),
  FOREIGN KEY(taxonomy_version) REFERENCES taxonomy_versions(version)
);

CREATE TABLE IF NOT EXISTS publication_source_watermarks (
  publication_id INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  batch_id INTEGER,
  PRIMARY KEY(publication_id, source_key),
  FOREIGN KEY(publication_id) REFERENCES publications(id)
);

CREATE TABLE IF NOT EXISTS publication_exclusions (
  publication_id INTEGER NOT NULL,
  complaint_id INTEGER NOT NULL,
  reason TEXT NOT NULL,                 -- withdrawn | 人工排除理由码
  PRIMARY KEY(publication_id, complaint_id),
  FOREIGN KEY(publication_id) REFERENCES publications(id),
  FOREIGN KEY(complaint_id) REFERENCES complaints(id)
);

-- 快照成员：发布时刻的身份/分类解析与相对上一版的差异原因
CREATE TABLE IF NOT EXISTS publication_complaints (
  publication_id INTEGER NOT NULL,
  complaint_id INTEGER NOT NULL,
  resolved_merchant_id INTEGER NOT NULL,
  resolved_term_code TEXT NOT NULL,
  included INTEGER NOT NULL CHECK(included IN (0,1)),
  exclusion_reason TEXT,
  change_reason TEXT CHECK(change_reason IS NULL OR change_reason IN (
    'late_arrival','withdrawal','identity_correction',
    'classification_change','exclusion_change'
  )),
  PRIMARY KEY(publication_id, complaint_id),
  FOREIGN KEY(publication_id) REFERENCES publications(id),
  FOREIGN KEY(complaint_id) REFERENCES complaints(id),
  FOREIGN KEY(resolved_merchant_id) REFERENCES merchants(id)
);
CREATE INDEX IF NOT EXISTS idx_pub_complaints_cell
  ON publication_complaints(publication_id, resolved_merchant_id, resolved_term_code);

CREATE TABLE IF NOT EXISTS publication_cells (
  publication_id INTEGER NOT NULL,
  merchant_id INTEGER NOT NULL,
  term_code TEXT NOT NULL,
  complaint_count INTEGER NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  PRIMARY KEY(publication_id, merchant_id, term_code),
  FOREIGN KEY(publication_id) REFERENCES publications(id),
  FOREIGN KEY(merchant_id) REFERENCES merchants(id)
);

-- 6. 查看者与职责范围（下钻去标识化证据的授权边界）
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('publisher','analyst','viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS viewer_scopes (
  user_id TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('merchant','category','all')),
  scope_value TEXT NOT NULL,           -- merchant_ref / term_code；all 时为 *
  PRIMARY KEY(user_id, dimension, scope_value),
  FOREIGN KEY(user_id) REFERENCES users(user_id)
);

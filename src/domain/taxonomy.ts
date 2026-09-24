import type Database from "better-sqlite3";
import { rawDb } from "../database.js";
import { DomainError } from "./types.js";

export function createTaxonomyVersion(version: string, db: Database.Database = rawDb()): void {
  db.prepare("INSERT OR IGNORE INTO taxonomy_versions(version) VALUES (?)").run(version);
}

export interface TermInput {
  code: string;
  label: string;
  parentCode?: string | null;
}

export function putTerms(version: string, terms: TermInput[], db: Database.Database = rawDb()): void {
  const exists = db.prepare("SELECT 1 FROM taxonomy_versions WHERE version = ?").get(version);
  if (!exists) throw new DomainError("TAXONOMY_VERSION_NOT_FOUND", `分类版本不存在: ${version}`);
  const tx = db.transaction(() => {
    for (const term of terms) {
      if (term.parentCode) {
        const parent = db.prepare("SELECT 1 FROM taxonomy_terms WHERE version = ? AND code = ?").get(version, term.parentCode);
        if (!parent) throw new DomainError("TERM_NOT_FOUND", `父词条不存在: ${term.parentCode}`);
      }
      db.prepare(
        `INSERT INTO taxonomy_terms(version, code, label, parent_code) VALUES (?,?,?,?)
         ON CONFLICT(version, code) DO UPDATE SET label = excluded.label, parent_code = excluded.parent_code`,
      ).run(version, term.code, term.label, term.parentCode ?? null);
    }
  });
  tx.immediate();
}

export interface RuleInput {
  matchText: string;
  termCode: string;
  validFrom: string;
  validTo?: string | null;
}

function assertRuleRange(
  db: Database.Database,
  version: string,
  match: string,
  from: string,
  to: string | null,
) {
  const rows = db
    .prepare(
      "SELECT valid_from, valid_to FROM taxonomy_rules WHERE version = ? AND match_text = ? COLLATE NOCASE",
    )
    .all(version, match) as { valid_from: string; valid_to: string | null }[];
  for (const row of rows) {
    const rowTo = row.valid_to ?? "9999-12-31";
    const newTo = to ?? "9999-12-31";
    if (row.valid_from < newTo && from < rowTo) {
      throw new DomainError("RULE_RANGE_OVERLAP", `归类规则「${match}」有效区间重叠`, {
        existing: { validFrom: row.valid_from, validTo: row.valid_to },
      });
    }
  }
}

export function putRules(version: string, rules: RuleInput[], db: Database.Database = rawDb()): void {
  const tx = db.transaction(() => {
    for (const rule of rules) {
      const term = db.prepare("SELECT 1 FROM taxonomy_terms WHERE version = ? AND code = ?").get(version, rule.termCode);
      if (!term) throw new DomainError("TERM_NOT_FOUND", `词条不存在: ${rule.termCode}`);
      const to = rule.validTo ?? null;
      if (to && to <= rule.validFrom) throw new DomainError("INVALID_PAYLOAD", "validTo 必须晚于 validFrom");
      assertRuleRange(db, version, rule.matchText, rule.validFrom, to);
      db.prepare(
        "INSERT INTO taxonomy_rules(version, match_text, term_code, valid_from, valid_to) VALUES (?,?,?,?,?)",
      ).run(version, rule.matchText, rule.termCode, rule.validFrom, to);
    }
  });
  tx.immediate();
}

/** 按投诉发生日期解析该分类版本下的词条；无规则命中返回 null（候选保持未决） */
export function classifyText(
  version: string,
  text: string,
  atDate: string,
  db: Database.Database = rawDb(),
): string | null {
  const rows = db
    .prepare(
      `SELECT term_code AS code, match_text AS matchText
       FROM taxonomy_rules
       WHERE version = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .all(version, atDate, atDate) as { code: string; matchText: string }[];
  const haystack = text.toLowerCase();
  // 最长关键词优先，保证多个命中时取最具体的规则
  const hit = rows
    .filter((r) => haystack.includes(r.matchText.toLowerCase()))
    .sort((a, b) => b.matchText.length - a.matchText.length)[0];
  return hit?.code ?? null;
}

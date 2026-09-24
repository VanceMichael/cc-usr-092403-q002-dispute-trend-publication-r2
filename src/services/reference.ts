import type Database from "better-sqlite3";
import { fail } from "../errors.js";
import { asObject, checkMonth, optArray, optString, reqArray, reqString } from "../validate.js";

/** 追加一条商家身份区间；身份纠正就是新区间，历史行保持不变。 */
export function addIdentityMapping(db: Database.Database, body: unknown) {
  const obj = asObject(body);
  const alias = reqString(obj, "alias");
  const merchantKey = reqString(obj, "merchant_key");
  const validFrom = checkMonth(reqString(obj, "valid_from"), "valid_from");
  const validToRaw = optString(obj, "valid_to");
  const validTo = validToRaw === undefined ? null : checkMonth(validToRaw, "valid_to");
  if (validTo !== null && validTo <= validFrom) {
    fail(400, "VALIDATION_FAILED", "valid_to 必须晚于 valid_from");
  }
  const inserted = db
    .prepare("INSERT INTO merchant_identity_map (alias, merchant_key, valid_from, valid_to) VALUES (?, ?, ?, ?)")
    .run(alias, merchantKey, validFrom, validTo);
  return db.prepare("SELECT * FROM merchant_identity_map WHERE map_id = ?").get(Number(inserted.lastInsertRowid));
}

export function listIdentityMappings(db: Database.Database, alias: string | undefined) {
  if (alias === undefined) {
    return db.prepare("SELECT * FROM merchant_identity_map ORDER BY alias, valid_from, map_id").all();
  }
  return db
    .prepare("SELECT * FROM merchant_identity_map WHERE alias = ? ORDER BY valid_from, map_id")
    .all(alias);
}

/** 解析某别名在指定月份生效的归并商家；无映射时以别名自身作为商家键。 */
export function resolveMerchant(db: Database.Database, alias: string, month: string): string {
  const row = db
    .prepare(
      `SELECT merchant_key FROM merchant_identity_map
       WHERE alias = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY valid_from DESC, map_id DESC LIMIT 1`,
    )
    .get(alias, month, month) as { merchant_key: string } | undefined;
  return row?.merchant_key ?? alias;
}

interface CategoryInput {
  category_key: string;
  label: string;
  keywords: string[];
  valid_from: string;
  valid_to: string | null;
}

function parseCategory(value: unknown, index: number): CategoryInput {
  const obj = asObject(value, `categories[${index}]`);
  const keywordsRaw = obj.keywords;
  const keywords =
    keywordsRaw === undefined || keywordsRaw === null
      ? []
      : optArray({ keywords: keywordsRaw }, "keywords").map((keyword, i) => {
          if (typeof keyword !== "string" || keyword.length === 0) {
            fail(400, "VALIDATION_FAILED", `categories[${index}].keywords[${i}] 必须是非空字符串`);
          }
          return keyword;
        });
  const validFrom = checkMonth(reqString(obj, "valid_from"), "valid_from");
  const validToRaw = optString(obj, "valid_to");
  const validTo = validToRaw === undefined ? null : checkMonth(validToRaw, "valid_to");
  if (validTo !== null && validTo <= validFrom) {
    fail(400, "VALIDATION_FAILED", `categories[${index}] 的 valid_to 必须晚于 valid_from`);
  }
  return {
    category_key: reqString(obj, "category_key"),
    label: reqString(obj, "label"),
    keywords,
    valid_from: validFrom,
    valid_to: validTo,
  };
}

/** 创建分类词典版本；版本不可变，重复创建同名版本被拒绝。 */
export function createTaxonomyVersion(db: Database.Database, body: unknown) {
  const obj = asObject(body);
  const versionKey = reqString(obj, "version_key");
  const categories = reqArray(obj, "categories").map(parseCategory);
  const existing = db.prepare("SELECT version_key FROM taxonomy_versions WHERE version_key = ?").get(versionKey);
  if (existing) fail(409, "TAXONOMY_VERSION_EXISTS", `分类版本 ${versionKey} 已存在，词典版本不可变`);

  const create = db.transaction(() => {
    db.prepare("INSERT INTO taxonomy_versions (version_key) VALUES (?)").run(versionKey);
    const insert = db.prepare(
      `INSERT INTO taxonomy_categories (version_key, category_key, label, keywords, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const category of categories) {
      insert.run(
        versionKey,
        category.category_key,
        category.label,
        JSON.stringify(category.keywords),
        category.valid_from,
        category.valid_to,
      );
    }
  });
  create.immediate();
  return getTaxonomyVersion(db, versionKey);
}

export function getTaxonomyVersion(db: Database.Database, versionKey: string) {
  const version = db
    .prepare("SELECT version_key, created_at FROM taxonomy_versions WHERE version_key = ?")
    .get(versionKey) as { version_key: string; created_at: string } | undefined;
  if (!version) fail(404, "TAXONOMY_VERSION_NOT_FOUND", `分类版本 ${versionKey} 不存在`);
  const categories = db
    .prepare("SELECT * FROM taxonomy_categories WHERE version_key = ? ORDER BY category_key")
    .all(versionKey) as Array<Record<string, unknown>>;
  return {
    ...version,
    categories: categories.map((row) => ({ ...row, keywords: JSON.parse(row.keywords as string) })),
  };
}

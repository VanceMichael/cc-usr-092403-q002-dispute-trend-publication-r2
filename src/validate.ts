import { fail } from "./errors.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function asObject(value: unknown, what = "请求体"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(400, "VALIDATION_FAILED", `${what}必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export function reqString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.length === 0) {
    fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是非空字符串`);
  }
  return value;
}

export function optString(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是字符串`);
  return value;
}

export function optInt(obj: Record<string, unknown>, field: string): number | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是正整数`);
  }
  return value as number;
}

export function reqArray(obj: Record<string, unknown>, field: string): unknown[] {
  const value = obj[field];
  if (!Array.isArray(value)) fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是数组`);
  return value;
}

export function optArray(obj: Record<string, unknown>, field: string): unknown[] {
  const value = obj[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是数组`);
  return value;
}

export function reqMonth(obj: Record<string, unknown>, field: string): string {
  const value = reqString(obj, field);
  if (!MONTH_RE.test(value)) fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是 YYYY-MM 格式`);
  return value;
}

export function checkMonth(value: string, field: string): string {
  if (!MONTH_RE.test(value)) fail(400, "VALIDATION_FAILED", `字段 ${field} 必须是 YYYY-MM 格式`);
  return value;
}

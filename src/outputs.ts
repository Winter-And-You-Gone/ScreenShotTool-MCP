// Output schema validation + sensitive-value guards.
//
// Every tool contract carries an outputSchema. Every pipeline step result is
// validated against its tool's outputSchema before it can be referenced by a
// later step (TOOL_OUTPUT_SCHEMA_MISMATCH otherwise), and exports are checked
// for sensitive fields before they are stored. This module implements a small
// structural JSON-Schema subset validator (type / required / properties /
// items / enum / anyOf) - enough for the contract table in contracts.ts.

import type { JsonSchema } from "./contracts.js";

// Field-name suffixes/segments that are never allowed in exports or pipe
// references, regardless of the tool that produced them.
const SENSITIVE_SEGMENTS = ["password", "token", "credential", "secret", "authorization", "cookie"];

export function isSensitiveFieldName(segments: string[]): boolean {
  return segments.some((seg) => {
    const lower = seg.toLowerCase();
    return SENSITIVE_SEGMENTS.some((s) => lower.includes(s));
  });
}

export type OutputValidation = { ok: true } | { ok: false; reason: string };

// Validate a value against a JSON Schema. Only the subset used by the
// contract table is supported; unknown keywords are ignored. Extra properties
// beyond the declared ones are allowed (forward compatibility).
export function validateAgainstSchema(value: unknown, schema: JsonSchema | undefined): OutputValidation {
  if (!schema) return { ok: true };
  const v = validateNode(value, schema, "$");
  if (v.ok) return { ok: true };
  return { ok: false, reason: v.reason };
}

function validateNode(value: unknown, schema: JsonSchema, path: string): OutputValidation {
  // anyOf: at least one branch must validate.
  if (schema.anyOf && schema.anyOf.length > 0) {
    const branch = schema.anyOf.find((b) => validateNode(value, b, path).ok);
    if (branch === undefined) {
      return { ok: false, reason: `value at ${path} does not match any anyOf branch` };
    }
    return { ok: true };
  }

  if (schema.type !== undefined) {
    const t = schema.type;
    const typeOk =
      t === "string" ? typeof value === "string"
        : t === "number" ? typeof value === "number" && Number.isFinite(value)
          : t === "integer" ? typeof value === "number" && Number.isInteger(value)
            : t === "boolean" ? typeof value === "boolean"
              : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
                : t === "array" ? Array.isArray(value)
                  : t === "null" ? value === null
                    : true;
    if (!typeOk) {
      return { ok: false, reason: `expected ${t} at ${path}, got ${value === null ? "null" : typeof value}` };
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => e === value)) {
      return { ok: false, reason: `value at ${path} is not one of the allowed enum values` };
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const r = validateNode(value[i], schema.items, `${path}[${i}]`);
      if (!r.ok) return r;
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (record[key] !== undefined) {
        const r = validateNode(record[key], sub, `${path}.${key}`);
        if (!r.ok) return r;
      }
    }
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) {
        return { ok: false, reason: `missing required field '${path}.${key}'` };
      }
    }
  }

  return { ok: true };
}

// Size limits for single pipeline results (spec).
export const MAX_STEP_RESULT_BYTES = 1 * 1024 * 1024;
export const MAX_PIPELINE_RESULT_BYTES = 5 * 1024 * 1024;

export function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Recursively walk a value, calling onLeaf for every leaf path (object keys
// and array indices). Used by export resolution.
export type LeafVisitor = (path: string[], value: unknown) => void;

export function walkLeaves(value: unknown, onLeaf: LeafVisitor, prefix: string[] = []): void {
  if (value === null || value === undefined) {
    onLeaf(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkLeaves(value[i], onLeaf, [...prefix, String(i)]);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkLeaves(v, onLeaf, [...prefix, k]);
    }
    return;
  }
  onLeaf(prefix, value);
}

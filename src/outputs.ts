// Output schema validation + sensitive-value guards.
//
// Every tool contract carries an outputSchema. Every tool call - whether a
// plain tools/call or a pipeline step - is validated against its tool's
// outputSchema by the unified executor (src/executor.ts) before the result is
// returned (TOOL_OUTPUT_SCHEMA_MISMATCH otherwise). Invalid results never flow
// into later steps, exports, run snapshots, or structuredContent.
//
// This module implements a small structural JSON-Schema subset validator
// (type / required / properties / items / enum / anyOf) - enough for the
// contract table in contracts.ts - that reports STRUCTURED errors
// ({path, message}) instead of a single message string.

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

export type ValidationError = {
  path: string;
  message: string;
};

export type OutputValidation = { ok: true } | { ok: false; reason: string; errors: ValidationError[] };

// Validate a value against a JSON Schema. Only the subset used by the
// contract table is supported; unknown keywords are ignored. Extra properties
// beyond the declared ones are allowed (forward compatibility).
//
// ARRAY COMPATIBILITY: MCP requires an object-root outputSchema, so array
// tools (e.g. list_windows) declare `{ type: "object", properties: { items:
// { type: "array", ... } }, required: ["items"] }` while their raw result is
// the bare array. When a schema declares exactly that shape and the value is
// an array, the value is validated as `{ items: value }` - keeping the public
// contract (and structuredContent `{items:[...]}`) consistent with the raw
// value used by ${N.path} references.
export function validateAgainstSchema(value: unknown, schema: JsonSchema | undefined): OutputValidation {
  if (!schema) return { ok: true };
  let errors: ValidationError[] = [];
  const ok = validateNode(value, schema, "$", errors, schema);
  if (ok) return { ok: true };
  return { ok: false, reason: errors[0]?.message ?? "output schema mismatch", errors };
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: ValidationError[],
  rootSchema: JsonSchema
): boolean {
  // Array-compat auto-wrap: object schema whose only array property is
  // "items", against a raw array value.
  if (
    schema.type === "object"
    && Array.isArray(value)
    && schema.properties?.items?.type === "array"
    && schema.required?.includes("items")
  ) {
    return validateNode({ items: value }, schema, path, errors, rootSchema);
  }

  let valid = true;
  const fail = (message: string): void => {
    valid = false;
    errors.push({ path, message });
  };

  // anyOf: at least one branch must validate (checked against a scratch
  // error list so a failed branch does not pollute the report).
  if (schema.anyOf && schema.anyOf.length > 0) {
    const branchHits = schema.anyOf.some((b) => {
      const scratch: ValidationError[] = [];
      return validateNode(value, b, path, scratch, rootSchema);
    });
    if (!branchHits) {
      fail(`value at ${path} does not match any anyOf branch`);
    }
    return valid;
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
      fail(`expected ${t} at ${path}, got ${value === null ? "null" : typeof value}`);
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => e === value)) {
      fail(`value at ${path} is not one of the allowed enum values`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      if (!validateNode(value[i], schema.items, `${path}[${i}]`, errors, rootSchema)) valid = false;
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const record = value as Record<string, unknown>;
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (record[key] !== undefined) {
        if (!validateNode(record[key], sub, `${path}.${key}`, errors, rootSchema)) valid = false;
      }
    }
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) {
        fail(`missing required field '${path}.${key}'`);
      }
    }
  }

  return valid;
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

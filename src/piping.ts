// Output-piping support for run_steps.
//
// A step's args may contain ${N.path} placeholders that are resolved against
// the raw results of earlier steps before the step is dispatched. The syntax
// is deliberately narrow so that real ${...} strings in arguments (PowerShell
// variables, shell snippets) are not accidentally interpolated:
//
//   ${N}            -> the entire result of step N
//   ${N.field}      -> result.field of step N
//   ${N.a.b}        -> nested field access
//   ${N.0.field}    -> array index (numeric path segment)
//
// Rules:
//   - Only ${<digits>.<dotted-path>} matches. Anything else is literal.
//   - A whole-string placeholder (args value is exactly "${0.pid}") preserves
//     the referenced value's type. An embedded placeholder stringifies it.
//   - A step may only reference earlier steps (index < its own). Forward
//     references are rejected structurally before any step runs.
//   - A path that can't be resolved (missing field, null mid-path, bad index)
//     fails the step at runtime and stops the chain.

export type Resolution = { ok: true; value: unknown } | { ok: false; reason: string };

export type ValidationResult = { ok: true } | { ok: false; message: string };

export type StepLike = { tool: string; args: unknown };

// Matches ${N} or ${N.path.seg...}. Capture group 1 is "N.path.seg".
// N is digits; each path segment is \w+ (covers identifiers and numeric
// indices alike). The regex is global so matchAll can find every occurrence.
const PLACEHOLDER_RE = /\$\{(\d+(?:\.\w+)*)\}/g;
// A whole-string placeholder: the entire value is one ${...} with nothing
// around it. Non-global so exec returns the first (and only) match or null.
const WHOLE_PLACEHOLDER_RE = /^\$\{(\d+(?:\.\w+)*)\}$/;

// Structural pre-check: every placeholder must reference an earlier step.
// Forward references - and thus references to steps that don't exist - are
// rejected before any step runs. Returns a validation result; the caller
// decides how to surface the error.
export function validateReferences(steps: StepLike[]): ValidationResult {
  const violations: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    for (const ref of extractReferences(steps[i]!.args)) {
      if (ref >= i) {
        violations.push(`step ${i} references step ${ref} (must be < ${i})`);
      }
    }
  }
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    message: `run_steps placeholder references are invalid: ${violations.join("; ")}. A step may only reference earlier steps.`
  };
}

// Resolve every ${N.path} placeholder in args against the raw results of
// completed steps. `results[N]` is step N's result. Walks objects and arrays
// recursively; primitives pass through unchanged.
export function resolvePlaceholders(args: unknown, results: unknown[]): Resolution {
  return resolveNode(args, results);
}

// Collect every step index referenced by placeholders anywhere in the value
// tree. Used by validateReferences.
function extractReferences(value: unknown): number[] {
  const refs: number[] = [];
  walk(value);
  return refs;

  function walk(v: unknown) {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER_RE)) {
        const idx = Number(m[1]!.split(".")[0]);
        if (!refs.includes(idx)) refs.push(idx);
      }
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    } else if (v && typeof v === "object") {
      for (const val of Object.values(v)) walk(val);
    }
  }
}

function resolveNode(value: unknown, results: unknown[]): Resolution {
  if (typeof value === "string") return resolveString(value, results);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      const r = resolveNode(el, results);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveNode(v, results);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  // number, boolean, null, undefined - pass through.
  return { ok: true, value };
}

function resolveString(s: string, results: unknown[]): Resolution {
  // Whole-string placeholder: preserve the referenced value's type.
  const whole = WHOLE_PLACEHOLDER_RE.exec(s);
  if (whole) return resolveReference(whole[1]!, results);

  // No placeholder at all - literal string.
  const matches = [...s.matchAll(PLACEHOLDER_RE)];
  if (matches.length === 0) return { ok: true, value: s };

  // One or more embedded placeholders: stringify each and concatenate.
  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += s.slice(lastIndex, m.index);
    const r = resolveReference(m[1]!, results);
    if (!r.ok) return r;
    result += stringify(r.value);
    lastIndex = m.index! + m[0].length;
  }
  result += s.slice(lastIndex);
  return { ok: true, value: result };
}

// Resolve a single "N.path.seg" reference against the results array.
function resolveReference(ref: string, results: unknown[]): Resolution {
  const parts = ref.split(".");
  const stepIdx = Number(parts[0]);
  if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= results.length) {
    return {
      ok: false,
      reason: `placeholder \${${ref}} references step ${parts[0]} which has no result (only ${results.length} step(s) have completed)`
    };
  }

  let current: unknown = results[stepIdx];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!;
    const traversed = parts.slice(0, i).join(".");

    // Check before each hop: null/undefined can't be indexed. (typeof null is
    // "object", so this guard must come before the object branch.)
    if (current == null) {
      return {
        ok: false,
        reason: `placeholder \${${ref}} could not be resolved: value is ${current === null ? "null" : "undefined"} at '${traversed}'`
      };
    }

    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return {
          ok: false,
          reason: `placeholder \${${ref}} could not be resolved: array index '${seg}' out of range at '${traversed}'`
        };
      }
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
      if (current === undefined) {
        return {
          ok: false,
          reason: `placeholder \${${ref}} could not be resolved: no field '${seg}' at '${traversed}'`
        };
      }
    } else {
      return {
        ok: false,
        reason: `placeholder \${${ref}} could not be resolved: cannot index into ${typeof current} at '${traversed}'`
      };
    }
  }

  return { ok: true, value: current };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

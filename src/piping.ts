// Output-piping support for pipeline steps (run_steps / profile_run_steps /
// run_workflow).
//
// A step's args may contain ${...} placeholders that are resolved against the
// results of earlier steps before the step is dispatched:
//
//   ${N}            -> the entire result of step N (numeric index)
//   ${stepId}       -> the entire result of the step with id 'stepId'
//   ${stepId.field} -> result.field of that step
//   ${pack.id}      -> the id of the currently executing App Pack
//   ${inputs.x}     -> workflow input 'x'
//
// Rules:
//   - Only ${<identifier>.<dotted-path>} matches. Anything else is literal.
//   - A whole-string placeholder (args value is exactly "${0.pid}") preserves
//     the referenced value's type. An embedded placeholder stringifies it.
//   - A step may only reference earlier steps (index < its own). Forward
//     references are rejected structurally before any step runs.
//   - A path that can't be resolved (missing field, null mid-path, bad index)
//     fails the step at runtime and stops the chain.

export type Resolution = { ok: true; value: unknown } | { ok: false; reason: string };

export type ValidationResult = { ok: true } | { ok: false; message: string };

export type StepLike = { tool: string; args: unknown };

export type StepLikeWithId = { id?: string; tool: string; args: unknown };

export type PipeContext = {
  // Results by step id (named steps).
  byId: Map<string, unknown>;
  // Results by step index (numeric references).
  byIndex: unknown[];
  // Server-injected pack id for ${pack.id}.
  pack?: { id: string };
  // Workflow inputs for ${inputs.x}.
  inputs?: Record<string, unknown>;
};

// Matches ${N} or ${N.path.seg...} where the head is either digits (index) or
// an identifier (step id / pack / inputs). Capture group 1 is the head,
// capture group 2 is ".path.seg" (including the leading dot). The negative
// lookahead keeps strings like "${env:PATH}" or "${not-a-ref}" literal - the
// head must be immediately followed by '.' or '}'.
const PLACEHOLDER_RE = /\$\{([A-Za-z0-9_]+)(?![A-Za-z0-9_:-])((?:\.[\w]+)*)\}/g;
// A whole-string placeholder: the entire value is one ${...} with nothing
// around it. Non-global so exec returns the first (and only) match or null.
const WHOLE_PLACEHOLDER_RE = /^\$\{([A-Za-z0-9_]+)((?:\.[\w]+)*)\}$/;

// Collect every (head, tail) referenced by placeholders anywhere in the value
// tree. head is the first segment (index digits or identifier).
export function extractReferenceHeads(value: unknown): Array<{ head: string; tail: string[] }> {
  const refs: Array<{ head: string; tail: string[] }> = [];
  walk(value);
  return refs;

  function walk(v: unknown): void {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER_RE)) {
        const head = m[1]!;
        const tail = m[2] ? m[2].slice(1).split(".") : [];
        if (!refs.some((r) => r.head === head && r.tail.join(".") === tail.join("."))) {
          refs.push({ head, tail });
        }
      }
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    } else if (v && typeof v === "object") {
      for (const val of Object.values(v)) walk(val);
    }
  }
}

// Structural pre-check: every placeholder must reference an earlier step
// (numeric index < current index, or a step id that was defined earlier),
// or the reserved names pack/inputs. Returns a validation result; the caller
// decides how to surface the error.
export function validateReferences(steps: StepLike[], ctx?: Pick<PipeContext, "pack" | "inputs">): ValidationResult {
  const violations: string[] = [];
  const idAt = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if ((step as StepLikeWithId).id) {
      idAt.set((step as StepLikeWithId).id!, i);
    }
  }
  for (let i = 0; i < steps.length; i++) {
    for (const ref of extractReferenceHeads(steps[i]!.args)) {
      const head = ref.head;
      if (/^\d+$/.test(head)) {
        const idx = Number(head);
        if (idx >= i) {
          violations.push(`step ${i} references step ${idx} (must be < ${i})`);
        }
      } else if (head === "pack" || head === "inputs") {
        // Server-injected; only valid when the context provides them.
        if (head === "pack" && !ctx?.pack) {
          violations.push(`step ${i} references ${head} but no pack context is set`);
        }
        if (head === "inputs" && !ctx?.inputs) {
          violations.push(`step ${i} references inputs but no workflow inputs are set`);
        }
      } else {
        const at = idAt.get(head);
        if (at === undefined) {
          violations.push(`step ${i} references unknown step id '${head}'`);
        } else if (at >= i) {
          violations.push(`step ${i} references step '${head}' (step ${at}, must be < ${i})`);
        }
      }
    }
  }
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    message: `pipeline placeholder references are invalid: ${violations.join("; ")}. A step may only reference earlier steps.`
  };
}

// Resolve every ${...} placeholder in args against the pipe context.
export function resolvePlaceholders(args: unknown, results: unknown[]): Resolution {
  return resolvePlaceholdersEx(args, { byId: new Map(), byIndex: results });
}

export function resolvePlaceholdersEx(args: unknown, ctx: PipeContext): Resolution {
  return resolveNode(args, ctx);
}

function resolveNode(value: unknown, ctx: PipeContext): Resolution {
  if (typeof value === "string") return resolveString(value, ctx);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const el of value) {
      const r = resolveNode(el, ctx);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveNode(v, ctx);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return { ok: true, value: out };
  }
  // number, boolean, null, undefined - pass through.
  return { ok: true, value };
}

function resolveString(s: string, ctx: PipeContext): Resolution {
  const whole = WHOLE_PLACEHOLDER_RE.exec(s);
  if (whole) return resolveReference(whole[1]!, whole[2] ?? "", ctx);

  const matches = [...s.matchAll(PLACEHOLDER_RE)];
  if (matches.length === 0) return { ok: true, value: s };

  let result = "";
  let lastIndex = 0;
  for (const m of matches) {
    result += s.slice(lastIndex, m.index);
    const r = resolveReference(m[1]!, m[2] ?? "", ctx);
    if (!r.ok) return r;
    result += stringify(r.value);
    lastIndex = m.index! + m[0].length;
  }
  result += s.slice(lastIndex);
  return { ok: true, value: result };
}

// Resolve a single "head.tail..." reference. head is digits (index) or an
// identifier (step id / pack / inputs).
function resolveReference(head: string, tailDot: string, ctx: PipeContext): Resolution {
  const parts = tailDot ? tailDot.slice(1).split(".") : [];
  const ref = head + tailDot;

  let current: unknown;
  if (/^\d+$/.test(head)) {
    const stepIdx = Number(head);
    if (stepIdx < 0 || stepIdx >= ctx.byIndex.length) {
      return {
        ok: false,
        reason: `placeholder \${${ref}} references step ${head} which has no result (only ${ctx.byIndex.length} step(s) have completed)`
      };
    }
    current = ctx.byIndex[stepIdx];
  } else if (head === "pack") {
    current = ctx.pack ? { id: ctx.pack.id } : undefined;
  } else if (head === "inputs") {
    current = ctx.inputs ?? {};
  } else {
    current = ctx.byId.get(head);
    if (current === undefined) {
      return { ok: false, reason: `placeholder \${${ref}} references unknown step id '${head}'` };
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const traversed = [head, ...parts.slice(0, i)].join(".");

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
      // CANONICAL-ARRAY COMPAT: array tools now return { items: [...] }
      // everywhere (outputSchema, structuredContent, pipeline results). Old
      // pipelines that reference the bare array directly (${0.0.hwnd}) keep
      // working: a top-level numeric segment is translated to items.N.
      if (/^\d+$/.test(seg) && Array.isArray((current as Record<string, unknown>).items)) {
        current = (current as Record<string, unknown>).items;
      }
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

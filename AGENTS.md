# AGENTS.md

## Language

默认使用中文回复。

## Project Overview

Windows-only MCP (Model Context Protocol) server that provides screenshot tools: launch apps, enumerate windows, capture window/screen regions, click, and close processes. Uses Node.js + TypeScript ESM, spawning PowerShell for Win32 API calls.

## Build / Lint / Test Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript (`tsc -p tsconfig.json`), output to `dist/` |
| `npm run dev` | Run server directly from source (`tsx src/index.ts`) |
| `npm start` | Run compiled server (`node dist/index.js`) |
| `npm test` | Run all unit tests (`node --test --import tsx tests/*.test.ts`) |
| `npm run smoke:notepad` | Windows desktop smoke test (launches/closes Notepad) |
| `npm run inspect` | Open MCP Inspector against the built server |

### Running a Single Test

```powershell
node --test --import tsx --test-name-pattern "pattern" tests/schemas.test.ts
```

Example:

```powershell
node --test --import tsx --test-name-pattern "launch_app" tests/schemas.test.ts
```

### Type Checking

`tsc --noEmit` (implied by `npm run build`). The project uses `strict: true` so any type errors block compilation. There is no separate lint or format step configured.

## Change Workflow

- After changing code, run the project build again when the change affects buildable sources or generated runtime output.
- After verification, commit code changes to the local Git repository. Do not push or configure a remote unless the user explicitly asks.

## Code Style

### Module System

ESM modules throughout. All relative imports must include the `.js` extension:

```ts
import { launchApp } from "./windows.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
```

### Import Order

1. External package imports (alphabetical)
2. Internal module imports (alphabetical, relative paths with `.js`)
3. Type-only imports (`import type`)

Example:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { launchAppSchema } from "./schemas.js";
import type { LaunchAppInput } from "./schemas.js";
import { launchApp } from "./windows.js";
```

### Node Built-ins

Always use the `node:` protocol prefix:

```ts
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
```

### Formatting

- 2-space indentation
- Semicolons required at end of statements
- Single quotes for strings (no template literals unless variables are interpolated)
- Trailing commas in multi-line object/array literals
- No trailing whitespace
- Files end with a trailing newline

### Types

- TypeScript `strict: true` — no `any` unless truly unavoidable
- Zod v4 for runtime input validation. Use `z.infer<typeof schema>` to derive types from schemas rather than duplicating them
- Exported types use `export type` (isolated) at module scope:

```ts
export type CaptureResult = {
  path: string;
  width: number;
  height: number;
  // ...
};
```

- Generic helpers use constrained type parameters:

```ts
function parseArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  // ...
}
```

- `null` is preferred over `undefined` for explicit "no value" semantics (e.g., `window: null` when `waitForWindow` is false)

### Naming

| Kind | Convention | Example |
|---|---|---|
| Variables / functions | camelCase | `defaultOutputDir`, `ensureOutputPath` |
| Types / interfaces | PascalCase | `CaptureResult`, `WindowInfo` |
| Constants | camelCase | `helperPath`, `positiveInt` |
| Files | kebab-case | `win-capture.ps1`, `smoke-notepad.ts` |
| MCP tool names | snake_case | `launch_app`, `capture_window` |

### Error Handling

- Throw `Error` with a descriptive message for operational failures (bad paths, invalid input)
- Throw `McpError(ErrorCode.InvalidParams, ...)` for schema validation failures in the MCP protocol layer
- Catch blocks re-throw `McpError` instances to preserve protocol semantics; all other errors are caught and returned as `{ isError: true, content: [...] }` for graceful degradation
- Use `try/finally` for cleanup (closing processes in smoke tests)

### Function Style

- Named `function` declarations at module scope
- Arrow functions (`=>`) for callbacks, inline handlers, and closures
- `async`/`await` throughout; avoid raw Promise chains
- Small helper functions for shared utilities (e.g., `timestampForFile`, `randomSuffix`, `delay`)

### Schemas

- Define reusable Zod fragments at the top of `schemas.ts` (e.g., `positiveInt`, `optionalTimeout`)
- Use `.refine()` for cross-field validation (e.g., requiring at least one window selector)
- Provide default values via `.default()` for optional fields
- Export both Zod schemas (for `parseArgs()`) and plain JSON Schema objects (`toolInputSchemas`) for the MCP `ListTools` response

### Tests

- Use Node.js built-in test runner (`node:test`) and assertions (`node:assert/strict`)
- Test files live in `tests/` and use the `.test.ts` suffix
- Test descriptions are human-readable strings describing expected behavior
- Unit tests validate schema parsing, defaults, and rejection of invalid input
- Async tests use `assert.rejects()` for expected promise rejections
- Smoke tests use top-level `await` and clean up in `finally` blocks

### Project Layout

```
src/         TypeScript source (compiled to dist/)
  index.ts   MCP server entry point
  windows.ts Windows OS interaction (PowerShell helper bridge)
  schemas.ts Zod schemas + MCP JSON Schema tool definitions
tests/       Test files (*.test.ts for unit, *.ts for smoke)
scripts/     PowerShell helper invoked by the Node process
outputs/     Generated screenshots (gitignored)
dist/        Compiled output (gitignored)
```

### Dependencies

- `@modelcontextprotocol/sdk` 1.29.0 — MCP server protocol
- `zod` 4.4.3 — Runtime schema validation
- `tsx` 4.x — TypeScript ESM execution (dev/test only)
- `typescript` ^5.9.3 — Compiler

Do not add new dependencies without a clear justification.

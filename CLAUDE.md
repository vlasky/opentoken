# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenToken is a token-compression engine for AI coding agents. It intercepts tool output (Bash, Read, Grep, Glob) and strips noise before it reaches the LLM, achieving 50-90% token reduction. It ships as a monorepo of five published packages plus integration adapters.

## Commands

This is a **Bun** monorepo (`bun >= 1.2`). There is **no build step** for the core/cli/mcp packages — Bun executes TypeScript directly and resolves `workspace:*` packages natively.

```bash
bun install            # Install dependencies
bun test               # Run all tests (Bun test runner)
bun run typecheck      # tsc --noEmit across project references
bun run lint           # Biome check (packages/)
bun run lint:fix       # Biome check --write
bun run checks:regex   # Scan source for catastrophic-backtracking regexes
bun run build          # Full gate: typecheck → lint → checks:regex → test
```

Run a single test file or filter by name:

```bash
bun test tests/core/folding.test.ts          # one file
bun test -t "fold consecutive"               # by test-name pattern
```

The `opencode` package is the only one with a real build (`bun build` bundling for Node + SolidJS TUI); run `bun run build` inside `packages/opencode/` when changing it.

CI order (`.github/workflows/ci.yml`): `typecheck` → `lint` → `checks:regex` → `test`. Match this locally before pushing.

## Package Layout

| Package | Name | Role |
|---|---|---|
| `packages/core` | `@mrgray17/opentoken-core` | Pure-logic compression engine. No platform deps. All real logic lives here. |
| `packages/cli` | `@mrgray17/opentoken-cli` | `opentoken` binary — pipe/wrap/stats modes |
| `packages/mcp` | `@mrgray17/opentoken-mcp` | MCP JSON-RPC server over stdio (`opentoken_transform`, `opentoken_rewrite`, `opentoken_stats`) |
| `packages/opencode` | `@mrgray17/opentoken` | OpenCode plugin adapter (+ SolidJS TUI) |
| `packages/claude-code` | `@mrgray17/opentoken-claude-code` | Claude Code hook scripts (`pretool-rewrite.mjs`, `posttool-compress.mjs`) + MCP/settings examples |

Everything except `opencode` consumes core via `workspace:*`. Tests import the published package names (`@mrgray17/opentoken-core`, `@mrgray17/opentoken`), not relative paths.

## Architecture

The engine has two interception points:

1. **Pre-call** (`core/src/precall.ts`) — rewrites noisy commands *before* execution (adds `--quiet`/`-s`/`-q` to npm, cargo, pytest, curl, docker, etc.) and blocks reads of minified/generated/lock files. ~46 rewrite patterns.
2. **Post-call** — compresses captured output. Entry point is `transformToolOutput(tool, command, output, opts)` in `core/src/transform.ts`, which dispatches by tool to one of four pipelines under `core/src/pipelines/` (`bash`, `read`, `grep`, `glob`).

The bash pipeline (`core/src/pipelines/bash.ts`) is the main path and shows the full stage flow:

```
redactSecrets → binary guard → oversize guard → stripThinking → stripAnsi
  → (skip if short) → whitespace/JSON/path/table/log normalizers
  → routeContent (content-aware) → family filter → reversible/abbreviate
  → LTSC → LZW → conservativeFilter
```

Two routing layers cooperate:
- **Family detection** (`core/src/families/detect.ts`) maps the *command* to one of 10 families (git, npm, cargo, docker, pip, make, test, fs, grep, generic), each with a dedicated filter in `core/src/families/`.
- **Content router** (`core/src/router.ts`) inspects the *output* to detect content type/language and select which heavy stages are worthwhile.

### Non-negotiable invariants

- **0-risk principle.** Every stage runs inside `safeStage`/`safeStageAsync` (`core/src/wrappers.ts`) and the whole pipeline ends in `conservativeFilter`. If a stage produces *more* tokens than it consumed, the original output is returned untouched. When adding a stage, it must be wrapped this way — never let a stage's output through unconditionally.
- **Token estimation, not char counting.** Comparisons use BPE token estimates (`core/src/utils/tokens.ts`) so 2-char compression markers that cost 2 tokens aren't treated as savings. Use `estimateTokens`/`safeEstimateTokens`, not `.length`.
- **A failing stage never breaks the pipeline.** `safeStage` catches, logs via `logError`, and returns the fallback. Preserve this — a transform bug should degrade to passthrough, not throw.
- **Auto-tuning gates heavy stages.** LTSC/LZW only run when `isStageWorthwhile(family)` (`core/src/autotune.ts`) says past metrics justify it.

### Adding a command family

Add the filter in `core/src/families/<name>.ts`, register the command keyword(s) in `FAMILY_MAP` in `families/detect.ts`, wire a `case` in the family switch in `pipelines/bash.ts`, export it from `core/src/index.ts`, and add tests in `tests/core/`.

## Conventions

- **Biome** is the formatter/linter, configured in `biome.json`: **tabs**, double quotes, organize-imports on. Notable enforced rules: `noExplicitAny` (error), `noNonNullAssertion` (error), `noImplicitAnyLet` (error). Do not introduce `any` or `!` non-null assertions.
- **Regex safety.** `scripts/check-regex-safety.ts` fails the build on nested unbounded quantifiers (`(.+)+`, `(\s+)*`, etc.) that cause catastrophic backtracking. Avoid these patterns — this codebase is regex-heavy and runs untrusted tool output through them.
- **Public API** is the explicit re-export list in `core/src/index.ts`. When adding exported symbols, add them there.
- **Bun-first, Node fallback.** Core must also run under Node ≥18 via `core/src/utils/fs-compat.ts`. Don't reach for Bun-only APIs in core without a compat path — the OpenCode plugin may run on either runtime.
- Optional user config lives at `~/.config/opentoken/config.json`, loaded via `core/src/config.ts` (`safeReadRoot`, `maxOutputBytes`, `enableMetrics`, `enableSymbolIndex`, …).

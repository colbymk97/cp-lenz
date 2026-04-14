# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript compile (tsc → dist/)
npm run lint           # ESLint with typescript-eslint
npm test               # Vitest (all tests)
npm run test:watch     # Vitest in watch mode

# Run a single test file
npx vitest run test/unit/storage/database.test.ts
```

**Note:** Storage tests (`test/unit/storage/`) crash locally on Apple Silicon when Node runs as x64 under Rosetta 2 — `sqlite-vec`'s prebuilt binary uses AVX instructions Rosetta doesn't support. These tests pass on native x86_64 (GitHub CI). Embedding tests always pass.

## Dev Workflow (build → install → run)

```bash
npm run dev:install    # build + vsce package + code --install-extension + open new window
# or directly:
bash scripts/dev-install.sh
```

This produces `yoink-dev.vsix`, installs it, and opens a new VS Code window. Use this whenever you want to manually test a change end-to-end.

**Viewing logs:** View → Output → select **Yoink**. Set `yoink.log.level = "debug"` in settings for verbose output.

## Packaging and Local Install

```bash
npm run build                                    # compile TypeScript first
npm run package                                  # vsce package → yoink-0.0.1.vsix
code --install-extension yoink-0.0.1.vsix     # install into VS Code
```

To uninstall:

```bash
code --uninstall-extension yoink.yoink
```

Dependencies (including native modules like `better-sqlite3` and `sqlite-vec`) are bundled into the VSIX. CI builds platform-specific VSIXs via `vsce package --target <platform>` on matching runners (linux-x64, darwin-arm64, darwin-x64).

**Apple Silicon note:** `dev-install.sh` detects x64 Node running under Rosetta and automatically rebuilds native modules for arm64 before packaging.

## Releasing

Push a version tag to trigger the release workflow, which builds platform-specific VSIXs and publishes a GitHub release:

```bash
git tag v0.0.1
git push origin v0.0.1
```

The workflow (`.github/workflows/release.yml`) runs on any `v*` tag, builds for each platform via `_build.yml`, and attaches all VSIXs to the release.

## Architecture Overview

Yoink is a VS Code extension that indexes GitHub repositories into a local SQLite vector database and exposes them as Copilot Chat tools.

### Dependency Wiring

`src/extension.ts` is the composition root. Its `activate()` function constructs every service, injects dependencies, and holds all disposables. Nothing is a singleton — all instances are created here and passed down.

### Data Pipeline (write path)

```
GitHub Trees API → fileFilter (glob) → GitHub Blobs API
  → chunker (512-token fixed-size, 64-token overlap, tiktoken)
  → OpenAI embedding API → better-sqlite3 (chunks + vec0)
```

`src/ingestion/pipeline.ts` orchestrates this. A concurrent queue (limit: 3 parallel data sources) is managed inside the pipeline. Status transitions (`queued → indexing → ready | error`) are written to both the SQLite `data_sources` table and `yoink.json`.

### Query Path (read path)

```
Copilot invokes tool → toolHandler → Retriever.search()
  → embed query → vec0 KNN search scoped by data_source_id
  → JOIN chunks → contextBuilder formats markdown → Copilot
```

Vector search is brute-force KNN via `sqlite-vec` (vec0 virtual table). Always scope searches with `data_source_id IN (...)` to avoid full-table scans.

### Key Abstractions

**`EmbeddingProvider`** (`src/embedding/embeddingProvider.ts`): Interface with `embed(texts)`, `dimensions`, and optional `countTokens()`. The registry (`src/embedding/registry.ts`) builds the concrete provider from VS Code settings. Changing providers requires dropping and recreating the `embeddings` vec0 table (different dimensions).

**`DataSourceConfig`** (`src/config/configSchema.ts`): The canonical representation of a repo. Written to `{globalStorageUri}/yoink.json` by `ConfigManager`. Mirrored into the `data_sources` SQLite table for query joins.

**`ToolConfig`** (`src/config/configSchema.ts`): Each tool maps `dataSourceIds[]` → a `vscode.lm.registerTool()` call. `ToolManager` diffs config on every change event and re-registers as needed.

### Config Layering

Two config systems coexist:
- **`yoink.json`** (in `globalStorageUri`): user data — data sources, tools, sync state. Managed by `ConfigManager`, watched for external edits.
- **VS Code settings** (`yoink.*` in `package.json` `contributes.configuration`): operational settings — embedding provider, API base URL, log level, topK. Read via `vscode.workspace.getConfiguration()`.

### API Key Storage

Resolution order: `SecretStorage` (OS keychain) → `OPENAI_API_KEY` env var → prompt user. Keys are never written to `settings.json` or `yoink.json`.

### Delta Sync

`src/sources/sync/deltaSync.ts` calls GitHub's Compare API between `lastSyncCommitSha` and current HEAD. Added/modified files are re-chunked and re-embedded; deleted files have their chunks and embeddings removed. Full re-index runs when `lastSyncCommitSha` is null.

### SQLite Schema Notes

The `embeddings` vec0 virtual table is created with a fixed dimension at DB init time (default 1536 for `text-embedding-3-small`). If the embedding model changes, `recreateEmbeddingsTable()` drops and recreates it and all data sources must re-index. Schema version is tracked in the `meta` table.

All tests use in-memory or temp-directory SQLite databases — no shared state between test files.

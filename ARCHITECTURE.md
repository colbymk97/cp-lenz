# Yoink Architecture

## 1. Folder & Module Structure

```
yoink/
├── package.json                  # Extension manifest, contributes, activation events
├── tsconfig.json
├── yoink.json.schema.json     # JSON Schema for yoink.json config file
├── src/
│   ├── extension.ts              # activate() / deactivate() — wires everything
│   │
│   ├── config/
│   │   ├── configManager.ts      # Read/write/watch yoink.json
│   │   ├── configSchema.ts       # TypeScript types for config file
│   │   └── settingsSchema.ts     # VS Code settings type definitions
│   │
│   ├── auth/
│   │   └── githubAuth.ts         # GitHub OAuth via VS Code authentication API
│   │
│   ├── sources/
│   │   ├── dataSource.ts         # DataSource interface + types
│   │   ├── dataSourceManager.ts  # CRUD lifecycle for data sources
│   │   ├── github/
│   │   │   ├── githubFetcher.ts  # GitHub API: list files, fetch content
│   │   │   ├── githubResolver.ts # Parse repo URLs, resolve default branch
│   │   │   └── repoBrowser.ts    # Search/browse user repos for wizard
│   │   └── sync/
│   │       ├── syncScheduler.ts  # Manual / on-startup / daily triggers
│   │       └── deltaSync.ts      # Compare commit SHAs, identify changed files
│   │
│   ├── ingestion/
│   │   ├── pipeline.ts           # Orchestrates: fetch → chunk → embed → store
│   │   ├── chunker.ts            # Chunking strategy (see §2)
│   │   └── fileFilter.ts         # Glob include/exclude matching
│   │
│   ├── embedding/
│   │   ├── embeddingProvider.ts   # EmbeddingProvider interface
│   │   ├── openaiProvider.ts     # OpenAI implementation
│   │   └── registry.ts           # Provider factory from config
│   │
│   ├── storage/
│   │   ├── database.ts           # better-sqlite3 init, migrations, connection
│   │   ├── chunkStore.ts         # Insert/query/delete chunks
│   │   ├── embeddingStore.ts     # Insert/query/delete embeddings (vec0)
│   │   └── syncStore.ts          # Sync history records
│   │
│   ├── retrieval/
│   │   ├── retriever.ts          # Vector search + re-ranking
│   │   └── contextBuilder.ts     # Format retrieved chunks for Copilot
│   │
│   ├── tools/
│   │   ├── toolManager.ts        # Register/unregister tools with Chat Tools API
│   │   ├── toolHandler.ts        # Handle tool invocations from Copilot
│   │   └── globalSearchTool.ts   # Built-in "search all" default tool
│   │
│   ├── ui/
│   │   ├── sidebar/
│   │   │   ├── sidebarProvider.ts    # TreeDataProvider for sidebar panel
│   │   │   └── sidebarTreeItems.ts   # Tree items: data sources, tools, status
│   │   ├── wizard/
│   │   │   └── addRepoWizard.ts  # Multi-step input wizard (QuickPick/InputBox)
│   │   └── commands.ts           # All registered commands
│   │
│   └── util/
│       ├── logger.ts             # OutputChannel-based logging
│       └── disposable.ts         # Disposable helpers
│
└── test/
    ├── unit/                     # Mirror of src/ structure
    └── integration/              # End-to-end with test fixtures
```

**Rationale:** Modules are organized by domain responsibility, not by technical layer. Each directory owns one concern. The `sources/github/` nesting anticipates non-GitHub sources in the future without requiring restructuring.

---

## 2. Key Abstractions & Interfaces

### EmbeddingProvider

```typescript
interface EmbeddingProvider {
  readonly id: string;
  readonly maxBatchSize: number;
  readonly dimensions: number;

  embed(texts: string[]): Promise<number[][]>;
}
```

Implementations: `OpenAIEmbeddingProvider` (v1), `OllamaEmbeddingProvider` (v1.1).

The registry reads VS Code settings and returns the configured provider. Changing providers requires re-indexing all data sources (dimensions may differ).

### DataSource

```typescript
interface DataSourceConfig {
  id: string;                         // UUID
  repoUrl: string;                    // e.g. "https://github.com/owner/repo"
  owner: string;
  repo: string;
  branch: string;                     // resolved default or user-specified
  includePatterns: string[];          // glob
  excludePatterns: string[];          // glob
  syncSchedule: 'manual' | 'onStartup' | 'daily';
  lastSyncedAt: string | null;        // ISO 8601
  lastSyncCommitSha: string | null;   // for delta sync
  status: 'queued' | 'indexing' | 'ready' | 'error';
  errorMessage?: string;
}
```

`DataSourceManager` owns the lifecycle: create, update, delete, trigger sync. It writes config changes to `yoink.json` and coordinates with the ingestion pipeline.

### Tool

```typescript
interface ToolConfig {
  id: string;                          // UUID
  name: string;                        // Copilot tool name (alphanumeric + underscores)
  description: string;                 // Copilot-optimized description
  dataSourceIds: string[];             // References to DataSourceConfig.id
}
```

`ToolManager` registers and unregisters `vscode.lm.ChatTool` instances. Each tool maps to a handler that queries the retriever scoped to its data sources.

### Ingestion Pipeline

```typescript
interface IngestionPipeline {
  ingest(dataSourceId: string, files: FetchedFile[]): Promise<void>;
  reingest(dataSourceId: string): Promise<void>;
  removeDataSource(dataSourceId: string): Promise<void>;
}

interface IngestionQueue {
  enqueue(dataSourceId: string): void;
  readonly concurrencyLimit: number;    // default: 3
  readonly running: ReadonlySet<string>;
  readonly pending: readonly string[];
}
```

Pipeline steps: `fileFilter → chunker → embeddingProvider → storage`

The `IngestionQueue` manages parallel indexing with a concurrency limit of 3. Data sources enter the queue and are processed as slots become available. The sidebar reflects real-time queue state.

### Chunking Strategy (Recommendation)

For code files, use **AST-unaware, overlap-based fixed-size chunking** for v1:

- **Chunk size:** 512 tokens (~2KB of code)
- **Overlap:** 64 tokens
- **File-boundary respect:** Never merge chunks across files
- **Metadata per chunk:** file path, start line, end line, data source ID

**Why not AST-based for v1:** AST parsing requires per-language parsers (tree-sitter bindings), adds significant native dependency weight, and chunking quality for retrieval is dominated more by embedding quality and chunk size than by syntactic boundaries. Fixed-size with overlap is the pragmatic v1 choice. AST-aware chunking is a good v1.1 enhancement.

For markdown/docs: same strategy works well since prose is less structure-dependent.

---

## 3. Data Flow

### Adding a Repository (end-to-end)

```
User invokes "Yoink: Add Repository"
  │
  ▼
┌─────────────────────┐
│   addRepoWizard.ts  │  Collect URL → resolve owner/repo/branch
│                     │  Configure include/exclude patterns
│                     │  Suggest tool name + description
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  configManager.ts   │  Write DataSourceConfig + ToolConfig
│                     │  to yoink.json
└────────┬────────────┘
         │
         ▼  (event emitted)
┌─────────────────────┐
│ dataSourceManager   │  Sets status = 'queued'
│                     │  Triggers ingestion pipeline
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  pipeline.ts        │  1. githubFetcher: list files via GitHub API
│                     │  2. fileFilter: apply include/exclude globs
│                     │  3. githubFetcher: fetch file contents (batched)
│                     │  4. chunker: split into chunks
│                     │  5. embeddingProvider: embed chunks (batched)
│                     │  6. storage: write chunks + embeddings to SQLite
│                     │  7. Update status = 'ready', record sync history
└─────────────────────┘
```

### Query Flow (Copilot → Tool → Response)

```
Copilot agent invokes registered tool
  │
  ▼
┌─────────────────────┐
│  toolHandler.ts     │  Receive query + tool ID
│                     │  Resolve data source IDs for this tool
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  retriever.ts       │  1. Embed query via embeddingProvider
│                     │  2. Vector search via vec0 (cosine distance)
│                     │     scoped to relevant data_source_ids
│                     │  3. Return top-K chunks (default K=10)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  contextBuilder.ts  │  Format chunks into structured context:
│                     │  - File path + line range
│                     │  - Chunk content
│                     │  - Source repo attribution
│                     │  Return as tool response to Copilot
└─────────────────────┘
```

### Delta Sync Flow

```
Sync triggered (manual / scheduled)
  │
  ▼
deltaSync.ts
  │  Compare lastSyncCommitSha with current branch HEAD
  │  via GitHub Compare API
  │
  ├── Changed files → re-fetch, re-chunk, re-embed, upsert
  ├── Deleted files → remove chunks + embeddings
  └── Unchanged files → skip
```

---

## 4. Chat Tools API Integration

VS Code's Chat Tools API (`vscode.lm` namespace) allows extensions to register tools that Copilot agents can invoke.

### Registration

In `extension.ts` → `activate()`:

```typescript
// For each tool in yoink.json config:
const disposable = vscode.lm.registerTool(
  `yoink.${tool.name}`,   // tool ID (namespaced)
  {
    // The tool implementation
    invoke: async (options, token) => {
      return toolHandler.handle(tool.id, options, token);
    },
    // Tool metadata
    displayName: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant code or documentation'
        }
      },
      required: ['query']
    }
  }
);
```

### Global Search Tool

Always registered, searches across all indexed data sources:

```typescript
vscode.lm.registerTool('yoink.search', {
  invoke: async (options, token) => {
    // Query all data sources, no scoping
    return toolHandler.handleGlobalSearch(options, token);
  },
  displayName: 'Yoink Search',
  description: 'Search across all configured repository knowledge bases',
  inputSchema: { /* same as above */ }
});
```

### Dynamic Registration

When config changes (data source added/removed, tool edited):
1. `configManager` emits a change event
2. `toolManager` diffs registered tools vs. config
3. Dispose removed tools, register new ones

---

## 5. SQLite Schema

### Recommendation: sqlite-vec (vec0) over sqlite-vss

**Use sqlite-vec.** sqlite-vss is deprecated by its own author (Alex Garcia) in favor of sqlite-vec.

| Concern | sqlite-vss | sqlite-vec |
|---|---|---|
| Dependencies | Faiss + OpenMP + C++ runtime | Zero (pure C) |
| Binary size | Multi-MB | ~200-400KB |
| npm distribution | No official package | `sqlite-vec` with prebuilds |
| better-sqlite3 compat | Fragile | First-class (`.loadExtension()`) |
| Electron/VS Code | Difficult | Straightforward |
| Maintenance | Deprecated | Active |
| Search method | ANN (Faiss IVF) | Brute-force KNN |

**Performance note:** sqlite-vec uses brute-force scan. At 500K vectors x 1536 dims, expect ~50-200ms per query. Acceptable for a VS Code extension (queries are user-initiated, not real-time). Partition by `data_source_id` in `WHERE` clauses to narrow scans when tools are scoped.

### Schema

```sql
-- Extension metadata / migrations
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracks configured data sources (mirrors yoink.json for query joins)
CREATE TABLE data_sources (
  id                TEXT PRIMARY KEY,     -- UUID
  owner             TEXT NOT NULL,
  repo              TEXT NOT NULL,
  branch            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  last_synced_at    TEXT,                 -- ISO 8601
  last_sync_commit  TEXT,                 -- SHA for delta sync
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexed file chunks
CREATE TABLE chunks (
  id              TEXT PRIMARY KEY,       -- UUID
  data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  content         TEXT NOT NULL,
  token_count     INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chunks_data_source ON chunks(data_source_id);
CREATE INDEX idx_chunks_file_path   ON chunks(data_source_id, file_path);

-- Vector embeddings via sqlite-vec
CREATE VIRTUAL TABLE embeddings USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[1536]                   -- matches text-embedding-3-small
);

-- NOTE: The dimensions value (1536) is set at table creation time based on
-- the configured embedding provider. If the provider changes, drop and
-- recreate this table + re-index.

-- Sync history for diagnostics
CREATE TABLE sync_history (
  id              TEXT PRIMARY KEY,       -- UUID
  data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  status          TEXT NOT NULL,          -- 'running' | 'completed' | 'failed'
  files_processed INTEGER DEFAULT 0,
  chunks_created  INTEGER DEFAULT 0,
  error_message   TEXT,
  commit_sha      TEXT                    -- HEAD at sync time
);

CREATE INDEX idx_sync_history_ds ON sync_history(data_source_id);
```

### Query Pattern (vector search scoped to data sources)

```sql
SELECT
  c.file_path,
  c.start_line,
  c.end_line,
  c.content,
  ds.owner,
  ds.repo,
  e.distance
FROM embeddings e
JOIN chunks c ON c.id = e.chunk_id
JOIN data_sources ds ON ds.id = c.data_source_id
WHERE e.embedding MATCH ?       -- query vector
  AND c.data_source_id IN (?, ?, ?)  -- tool's data sources
ORDER BY e.distance
LIMIT 10;
```

---

## 6. Config File Schema (`yoink.json`)

Stored at `{globalStorageUri}/yoink.json`.

```jsonc
{
  "version": 1,
  "dataSources": [
    {
      "id": "a1b2c3d4-...",
      "repoUrl": "https://github.com/microsoft/vscode",
      "owner": "microsoft",
      "repo": "vscode",
      "branch": "main",
      "includePatterns": ["src/**/*.ts"],
      "excludePatterns": ["**/test/**", "**/node_modules/**"],
      "syncSchedule": "onStartup",
      "lastSyncedAt": "2026-04-05T10:30:00Z",
      "lastSyncCommitSha": "abc123...",
      "status": "ready"
    }
  ],
  "tools": [
    {
      "id": "e5f6g7h8-...",
      "name": "vscode_api",
      "description": "Search the VS Code source code for API usage patterns, extension API implementations, and editor internals.",
      "dataSourceIds": ["a1b2c3d4-..."]
    }
  ],
  "defaultExcludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/*.min.js",
    "**/*.map",
    "**/*.png",
    "**/*.jpg",
    "**/*.gif",
    "**/*.ico",
    "**/*.woff",
    "**/*.woff2",
    "**/*.ttf",
    "**/*.eot"
  ]
}
```

---

## 7. VS Code Settings Schema

Contributed via `package.json` → `contributes.configuration`:

```jsonc
{
  "yoink.embedding.provider": {
    "type": "string",
    "enum": ["openai"],
    "default": "openai",
    "description": "Embedding provider to use for indexing."
  },
  "yoink.embedding.openai.model": {
    "type": "string",
    "default": "text-embedding-3-small",
    "description": "OpenAI embedding model to use."
  },
  "yoink.embedding.openai.baseUrl": {
    "type": "string",
    "default": "https://api.openai.com/v1",
    "description": "Base URL for OpenAI-compatible API (for proxies or compatible services)."
  },
  "yoink.search.topK": {
    "type": "number",
    "default": 10,
    "minimum": 1,
    "maximum": 50,
    "description": "Number of chunks to return per tool query."
  },
  "yoink.sync.onStartup": {
    "type": "boolean",
    "default": true,
    "description": "Automatically sync data sources marked 'onStartup' when VS Code launches."
  },
  "yoink.log.level": {
    "type": "string",
    "enum": ["debug", "info", "warn", "error"],
    "default": "info",
    "description": "Logging verbosity."
  }
}
```

---

## 8. Finalized Decisions

### 1. API key storage → SecretStorage + env var fallback

`vscode.SecretStorage` (OS keychain-backed) is the primary storage for API keys.
A command "Yoink: Set OpenAI API Key" writes to SecretStorage. The
`${env:OPENAI_API_KEY}` environment variable is supported as fallback. Raw API
keys are never stored in `settings.json`. Resolution order:

1. SecretStorage
2. `${env:OPENAI_API_KEY}`
3. Prompt user to set key

### 2. Embedding dimension migration → Drop + re-index

When the embedding provider or model changes (different vector dimensions), the
`embeddings` vec0 table is dropped and recreated with the new dimension. All
data sources are queued for full re-index. A confirmation dialog warns the user
before proceeding. Model changes are expected to be rare.

### 3. GitHub API strategy → Git Trees + Blobs API

Use the Git Trees API (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`)
to list the entire file tree in one request. Fetch file contents via the Git
Blobs API (`GET /repos/{owner}/{repo}/git/blobs/{sha}`), batched with
concurrency control to stay within rate limits. This minimizes API calls
compared to per-file Contents API. Git clone via subprocess is reserved as a
v1.1 optimization for very large repos.

### 4. Token counting → Provider-aware (tiktoken for OpenAI)

Use `tiktoken` (WASM build, ~2MB) for accurate token counting when using
OpenAI embedding models. The `EmbeddingProvider` interface exposes an optional
`countTokens(text: string): number` method. For providers without a tokenizer
(future Ollama support), fall back to `Math.ceil(text.length / 4)`.

### 5. Concurrent indexing → Parallel with concurrency limit

Multiple data sources can index in parallel with a concurrency limit of 3.
An ingestion queue manages scheduling. The sidebar shows per-source status
(queued / indexing / ready / error). This avoids blocking users who add
several repos at once.

### 6. Tool naming → Auto-generated with user override

Default tool name is auto-generated as `{owner}_{repo}` (e.g., `microsoft_vscode`).
Users can edit the name during the Add Repository wizard. Validation enforces
alphanumeric characters and underscores only, no spaces, max 64 characters.

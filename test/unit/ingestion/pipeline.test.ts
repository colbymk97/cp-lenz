import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { ChunkStore } from '../../../src/storage/chunkStore';
import { EmbeddingStore } from '../../../src/storage/embeddingStore';
import { SyncStore } from '../../../src/storage/syncStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';
import { GitHubFetcher } from '../../../src/sources/github/githubFetcher';
import {
  IngestionPipeline,
  PipelineConfigSource,
  PipelineEmbeddingSource,
  PipelineLogger,
} from '../../../src/ingestion/pipeline';
import { DataSourceConfig } from '../../../src/config/configSchema';
import { EmbeddingProvider } from '../../../src/embedding/embeddingProvider';

// --- Test fixtures ---

const TEST_DIMS = 4;

function makeDataSource(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: 'ds-1',
    repoUrl: 'https://github.com/test/repo',
    owner: 'test',
    repo: 'repo',
    branch: 'main',
    includePatterns: [],
    excludePatterns: [],
    syncSchedule: 'manual',
    lastSyncedAt: null,
    lastSyncCommitSha: null,
    status: 'queued',
    ...overrides,
  };
}

function makeMockProvider(): EmbeddingProvider {
  return {
    id: 'test',
    maxBatchSize: 100,
    dimensions: TEST_DIMS,
    embed: vi.fn().mockImplementation(async (texts: string[]) => {
      // Return a deterministic vector based on text length
      return texts.map((t) => {
        const val = t.length / 100;
        return [val, val, val, val];
      });
    }),
    countTokens: (text: string) => Math.ceil(text.length / 4),
  };
}

function makeMockLogger(): PipelineLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// --- Tests ---

describe('IngestionPipeline', () => {
  let db: Database.Database;
  let chunkStore: ChunkStore;
  let embeddingStore: EmbeddingStore;
  let syncStore: SyncStore;
  let dsStore: DataSourceStore;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    db = openDatabase({ dimensions: TEST_DIMS });
    chunkStore = new ChunkStore(db);
    embeddingStore = new EmbeddingStore(db);
    syncStore = new SyncStore(db);
    dsStore = new DataSourceStore(db);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  function makePipeline(
    dataSources: DataSourceConfig[],
    provider?: EmbeddingProvider,
  ) {
    const dsMap = new Map(dataSources.map((ds) => [ds.id, { ...ds }]));

    // Insert into DB for FK constraints
    for (const ds of dataSources) {
      dsStore.insert(ds.id, ds.owner, ds.repo, ds.branch, ds.status);
    }

    const config: PipelineConfigSource = {
      getDataSource: (id) => dsMap.get(id),
      getDefaultExcludePatterns: () => ['**/node_modules/**'],
      updateDataSource: (id, updates) => {
        const ds = dsMap.get(id);
        if (ds) Object.assign(ds, updates);
      },
    };

    const embeddingSource: PipelineEmbeddingSource = {
      getProvider: async () => provider ?? makeMockProvider(),
    };

    const logger = makeMockLogger();
    const fetcher = new GitHubFetcher(async () => 'test-token');

    return {
      pipeline: new IngestionPipeline(
        config,
        embeddingSource,
        fetcher,
        chunkStore,
        embeddingStore,
        syncStore,
        logger,
      ),
      config,
      logger,
      dsMap,
    };
  }

  function mockGitHubApi(files: Array<{ path: string; content: string }>) {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const headers = new Headers({
        'X-RateLimit-Remaining': '4999',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      });

      // Branch SHA
      if (urlStr.includes('/branches/')) {
        return {
          ok: true, status: 200, headers,
          json: async () => ({ commit: { sha: 'abc123' } }),
        };
      }

      // Tree
      if (urlStr.includes('/git/trees/')) {
        return {
          ok: true, status: 200, headers,
          json: async () => ({
            tree: files.map((f, i) => ({
              path: f.path,
              sha: `blob-sha-${i}`,
              size: f.content.length,
              type: 'blob',
            })),
            truncated: false,
          }),
        };
      }

      // Blob
      if (urlStr.includes('/git/blobs/')) {
        const sha = urlStr.split('/blobs/')[1];
        const idx = parseInt(sha.replace('blob-sha-', ''), 10);
        return {
          ok: true, status: 200, headers,
          text: async () => files[idx].content,
        };
      }

      return { ok: false, status: 404, headers, text: async () => 'not found' };
    });
  }

  it('ingests files end-to-end: fetch → filter → chunk → embed → store', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'src/index.ts', content: 'const hello = "world";\nexport default hello;' },
      { path: 'src/util.ts', content: 'export function add(a: number, b: number) {\n  return a + b;\n}' },
    ];

    mockGitHubApi(files);
    const { pipeline, dsMap } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    // Chunks were created
    const chunks = chunkStore.getByDataSource('ds-1');
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Embeddings were created (one per chunk)
    const results = embeddingStore.searchAll(
      [0.1, 0.1, 0.1, 0.1],
      100,
    );
    expect(results.length).toBe(chunks.length);

    // Sync history was recorded
    const sync = syncStore.getLatest('ds-1');
    expect(sync).toBeDefined();
    expect(sync!.status).toBe('completed');
    expect(sync!.filesProcessed).toBe(2);
    expect(sync!.chunksCreated).toBe(chunks.length);

    // Data source status updated
    const updatedDs = dsMap.get('ds-1')!;
    expect(updatedDs.status).toBe('ready');
    expect(updatedDs.lastSyncCommitSha).toBe('abc123');
  });

  it('applies file filters (include patterns)', async () => {
    const ds = makeDataSource({ includePatterns: ['**/*.ts'] });
    const files = [
      { path: 'src/index.ts', content: 'typescript code' },
      { path: 'src/style.css', content: 'body { color: red; }' },
      { path: 'docs/readme.md', content: '# README' },
    ];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    expect(filePaths).toEqual(['src/index.ts']);
  });

  it('applies default exclude patterns', async () => {
    const ds = makeDataSource();
    const files = [
      { path: 'src/index.ts', content: 'good code' },
      { path: 'node_modules/lodash/index.js', content: 'excluded' },
    ];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    expect(filePaths).toEqual(['src/index.ts']);
  });

  it('clears old chunks before re-indexing', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'first version' }];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    // First ingestion
    await pipeline.ingestDataSource('ds-1');
    expect(chunkStore.countByDataSource('ds-1')).toBeGreaterThan(0);

    // Re-index with different content
    const files2 = [{ path: 'b.ts', content: 'second version with more content' }];
    mockGitHubApi(files2);

    await pipeline.ingestDataSource('ds-1');

    const chunks = chunkStore.getByDataSource('ds-1');
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    // Old file should be gone, only new file present
    expect(filePaths).toEqual(['b.ts']);
  });

  it('sets error status on failure', async () => {
    const ds = makeDataSource();

    // Mock API that fails
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { pipeline, dsMap, logger } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');

    expect(dsMap.get('ds-1')!.status).toBe('error');
    expect(dsMap.get('ds-1')!.errorMessage).toContain('Network error');
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('removeDataSource clears chunks and embeddings', async () => {
    const ds = makeDataSource();
    const files = [{ path: 'a.ts', content: 'some code here' }];

    mockGitHubApi(files);
    const { pipeline } = makePipeline([ds]);

    await pipeline.ingestDataSource('ds-1');
    expect(chunkStore.countByDataSource('ds-1')).toBeGreaterThan(0);

    await pipeline.removeDataSource('ds-1');

    expect(chunkStore.countByDataSource('ds-1')).toBe(0);
    const results = embeddingStore.searchAll([0.1, 0.1, 0.1, 0.1], 100);
    expect(results).toHaveLength(0);
  });

  it('deduplicates enqueue calls', () => {
    const ds = makeDataSource();
    // Never-resolving fetch so the pipeline stays in "running" state
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { pipeline } = makePipeline([ds]);

    pipeline.enqueue('ds-1');
    pipeline.enqueue('ds-1'); // duplicate
    pipeline.enqueue('ds-1'); // duplicate

    // Should only have 0 in queue (1 is running)
    expect(pipeline.runningCount).toBe(1);
    expect(pipeline.queueSize).toBe(0);

    pipeline.dispose();
  });

  it('respects concurrency limit', async () => {
    // Use a separate in-memory DB for this test so we can leave it open
    // while hanging promises settle after the test.
    const testDb = openDatabase({ dimensions: TEST_DIMS });
    const testChunkStore = new ChunkStore(testDb);
    const testEmbeddingStore = new EmbeddingStore(testDb);
    const testSyncStore = new SyncStore(testDb);
    const testDsStore = new DataSourceStore(testDb);

    // Fetch that never resolves — we just want to inspect queue state
    globalThis.fetch = vi.fn().mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const dataSources = Array.from({ length: 5 }, (_, i) =>
      makeDataSource({ id: `ds-${i}`, owner: 'test', repo: `repo-${i}` }),
    );

    for (const ds of dataSources) {
      testDsStore.insert(ds.id, ds.owner, ds.repo, ds.branch, ds.status);
    }

    const dsMap = new Map(dataSources.map((ds) => [ds.id, { ...ds }]));
    const config: PipelineConfigSource = {
      getDataSource: (id) => dsMap.get(id),
      getDefaultExcludePatterns: () => [],
      updateDataSource: (id, updates) => {
        const d = dsMap.get(id);
        if (d) Object.assign(d, updates);
      },
    };
    const embeddingSource: PipelineEmbeddingSource = {
      getProvider: async () => makeMockProvider(),
    };

    const pipeline = new IngestionPipeline(
      config,
      embeddingSource,
      new GitHubFetcher(async () => 'token'),
      testChunkStore,
      testEmbeddingStore,
      testSyncStore,
      makeMockLogger(),
    );

    for (const ds of dataSources) {
      pipeline.enqueue(ds.id);
    }

    // 3 running (blocked on fetch), 2 queued
    expect(pipeline.runningCount).toBe(3);
    expect(pipeline.queueSize).toBe(2);

    // Dispose clears the queue. The 3 running promises hang forever
    // (never-resolving fetch) but that's fine — they'll be GC'd.
    pipeline.dispose();
    // Don't close testDb — the hanging promises may reference it.
    // In-memory DBs are cleaned up on GC.
  });
});

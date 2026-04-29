import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../../../src/storage/database';
import { EmbeddingStore } from '../../../src/storage/embeddingStore';
import { ChunkStore, ChunkRecord } from '../../../src/storage/chunkStore';
import { DataSourceStore } from '../../../src/storage/dataSourceStore';

// Use small dimensions for test performance
const TEST_DIMS = 4;

describe('EmbeddingStore', () => {
  let db: Database.Database;
  let embeddingStore: EmbeddingStore;
  let chunkStore: ChunkStore;
  let dsStore: DataSourceStore;

  beforeEach(() => {
    db = openDatabase({ dimensions: TEST_DIMS });
    embeddingStore = new EmbeddingStore(db);
    chunkStore = new ChunkStore(db);
    dsStore = new DataSourceStore(db);

    // Set up two data sources with chunks
    dsStore.insert('ds1', 'owner', 'repo1', 'main');
    dsStore.insert('ds2', 'owner', 'repo2', 'main');

    chunkStore.insertMany([
      makeChunk('c1', 'ds1', 'a.ts'),
      makeChunk('c2', 'ds1', 'b.ts'),
      makeChunk('c3', 'ds2', 'c.ts'),
      makeChunk('c4', 'ds2', 'd.ts'),
    ]);
  });

  afterEach(() => {
    db.close();
  });

  function makeChunk(id: string, dsId: string, filePath: string): ChunkRecord {
    return {
      id,
      dataSourceId: dsId,
      filePath,
      startLine: 1,
      endLine: 10,
      content: `content of ${filePath}`,
      tokenCount: 10,
    };
  }

  it('inserts and searches for nearest neighbors', () => {
    // Insert embeddings: c1 is close to query, c2 is far
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    embeddingStore.insert('c2', [0.0, 0.0, 0.0, 1.0]);

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 2);

    expect(results).toHaveLength(2);
    // c1 should be closest (distance ~0)
    expect(results[0].chunkId).toBe('c1');
    expect(results[0].distance).toBeCloseTo(0, 5);
    // c2 should be farther
    expect(results[1].chunkId).toBe('c2');
    expect(results[1].distance).toBeGreaterThan(0);
  });

  it('respects topK limit', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    embeddingStore.insert('c2', [0.5, 0.5, 0.0, 0.0]);
    embeddingStore.insert('c3', [0.0, 1.0, 0.0, 0.0]);
    embeddingStore.insert('c4', [0.0, 0.0, 1.0, 0.0]);

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].chunkId).toBe('c1');
  });

  it('insertMany inserts in a single transaction', () => {
    embeddingStore.insertMany([
      { chunkId: 'c1', embedding: [1.0, 0.0, 0.0, 0.0] },
      { chunkId: 'c2', embedding: [0.0, 1.0, 0.0, 0.0] },
      { chunkId: 'c3', embedding: [0.0, 0.0, 1.0, 0.0] },
    ]);

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 10);
    expect(results).toHaveLength(3);
  });

  it('deletes embeddings by chunk ids', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    embeddingStore.insert('c2', [0.0, 1.0, 0.0, 0.0]);

    embeddingStore.deleteByChunkIds(['c1']);

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 10);
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe('c2');
  });

  it('deleteByChunkIds with empty array is a no-op', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    embeddingStore.deleteByChunkIds([]);
    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 10);
    expect(results).toHaveLength(1);
  });

  it('deletes embeddings by data source', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    embeddingStore.insert('c2', [0.9, 0.1, 0.0, 0.0]);
    embeddingStore.insert('c3', [0.8, 0.2, 0.0, 0.0]);

    embeddingStore.deleteByDataSource('ds1');

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 10);
    expect(results).toHaveLength(1);
    expect(results[0].chunkId).toBe('c3');
  });

  it('searches scoped to specific data sources', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]); // ds1
    embeddingStore.insert('c2', [0.9, 0.1, 0.0, 0.0]); // ds1
    embeddingStore.insert('c3', [0.95, 0.05, 0.0, 0.0]); // ds2
    embeddingStore.insert('c4', [0.0, 0.0, 0.0, 1.0]); // ds2

    // Search only ds1
    const results = embeddingStore.search([1.0, 0.0, 0.0, 0.0], ['ds1'], 10);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.chunkId.startsWith('c1') || r.chunkId.startsWith('c2'))).toBe(
      true,
    );

    // Search only ds2
    const results2 = embeddingStore.search([1.0, 0.0, 0.0, 0.0], ['ds2'], 10);
    expect(results2).toHaveLength(2);
    // c3 should be closest in ds2
    expect(results2[0].chunkId).toBe('c3');
  });

  it('search with empty data source ids returns empty', () => {
    embeddingStore.insert('c1', [1.0, 0.0, 0.0, 0.0]);
    const results = embeddingStore.search([1.0, 0.0, 0.0, 0.0], [], 10);
    expect(results).toHaveLength(0);
  });

  it('returns results ordered by distance (ascending)', () => {
    embeddingStore.insert('c1', [0.0, 0.0, 0.0, 1.0]); // far from query
    embeddingStore.insert('c2', [0.9, 0.1, 0.0, 0.0]); // close
    embeddingStore.insert('c3', [1.0, 0.0, 0.0, 0.0]); // closest
    embeddingStore.insert('c4', [0.5, 0.5, 0.0, 0.0]); // medium

    const results = embeddingStore.searchAll([1.0, 0.0, 0.0, 0.0], 4);

    // Distances should be ascending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
    expect(results[0].chunkId).toBe('c3');
  });
});

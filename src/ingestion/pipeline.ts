import * as crypto from 'crypto';
import { DataSourceConfig } from '../config/configSchema';
import { EmbeddingProvider } from '../embedding/embeddingProvider';
import { GitHubFetcher } from '../sources/github/githubFetcher';
import { FileFilter } from './fileFilter';
import { Chunker } from './chunker';
import { ChunkStore, ChunkRecord } from '../storage/chunkStore';
import { EmbeddingStore } from '../storage/embeddingStore';
import { SyncStore } from '../storage/syncStore';

const MAX_CONCURRENCY = 3;

/**
 * Minimal interface for config access — decoupled from VS Code.
 */
export interface PipelineConfigSource {
  getDataSource(id: string): DataSourceConfig | undefined;
  getDefaultExcludePatterns(): string[];
  updateDataSource(id: string, updates: Partial<DataSourceConfig>): void;
}

/**
 * Minimal interface for embedding provider resolution.
 */
export interface PipelineEmbeddingSource {
  getProvider(): Promise<EmbeddingProvider>;
}

/**
 * Minimal logger interface — decoupled from VS Code OutputChannel.
 */
export interface PipelineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class IngestionPipeline {
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly config: PipelineConfigSource,
    private readonly embeddingSource: PipelineEmbeddingSource,
    private readonly fetcher: GitHubFetcher,
    private readonly chunkStore: ChunkStore,
    private readonly embeddingStore: EmbeddingStore,
    private readonly syncStore: SyncStore,
    private readonly logger: PipelineLogger,
  ) {}

  get queueSize(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running.size;
  }

  enqueue(dataSourceId: string): void {
    if (this.queue.includes(dataSourceId) || this.running.has(dataSourceId)) {
      return;
    }
    this.queue.push(dataSourceId);
    this.config.updateDataSource(dataSourceId, { status: 'queued' });
    this.processQueue();
  }

  private processQueue(): void {
    while (this.running.size < MAX_CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.running.add(id);
      this.ingestDataSource(id).finally(() => {
        this.running.delete(id);
        this.processQueue();
      });
    }
  }

  async ingestDataSource(dataSourceId: string): Promise<void> {
    const ds = this.config.getDataSource(dataSourceId);
    if (!ds) return;

    const syncId = crypto.randomUUID();
    let commitSha: string | null = null;

    try {
      this.config.updateDataSource(dataSourceId, { status: 'indexing' });
      this.logger.info(`Indexing ${ds.owner}/${ds.repo}@${ds.branch}`);

      // Get current HEAD
      commitSha = await this.fetcher.getBranchSha(ds.owner, ds.repo, ds.branch);
      this.syncStore.startSync(syncId, dataSourceId, commitSha);

      // Fetch file tree
      const { entries: tree, truncated } = await this.fetcher.getTree(ds.owner, ds.repo, commitSha);
      if (truncated) {
        this.logger.warn(`File tree for ${ds.owner}/${ds.repo} was truncated by GitHub API`);
      }

      // Filter files
      const filter = new FileFilter(
        ds.includePatterns,
        [...ds.excludePatterns, ...this.config.getDefaultExcludePatterns()],
      );
      const filteredEntries = tree.filter((entry) => filter.matches(entry.path));

      this.logger.info(`Fetching ${filteredEntries.length} files`);

      // Clear existing data for this source (full re-index)
      const oldChunkIds = this.chunkStore.getChunkIdsByDataSource(dataSourceId);
      this.embeddingStore.deleteByChunkIds(oldChunkIds);
      this.chunkStore.deleteByDataSource(dataSourceId);

      // Fetch file contents
      const files = await this.fetcher.fetchFiles(ds.owner, ds.repo, filteredEntries);

      // Get embedding provider and build chunker with its tokenizer
      const provider = await this.embeddingSource.getProvider();
      const chunker = new Chunker({
        countTokens: provider.countTokens
          ? (text: string) => provider.countTokens!(text)
          : undefined,
      });

      // Chunk all files
      const allChunks: ChunkRecord[] = [];
      for (const file of files) {
        const chunks = chunker.chunkFile(file.content, file.path);
        for (const chunk of chunks) {
          allChunks.push({
            id: crypto.randomUUID(),
            dataSourceId,
            filePath: file.path,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
          });
        }
      }

      // Store chunks
      this.chunkStore.insertMany(allChunks);

      // Embed in batches
      await this.embedChunks(allChunks, provider);

      // Update state
      this.config.updateDataSource(dataSourceId, {
        status: 'ready',
        lastSyncedAt: new Date().toISOString(),
        lastSyncCommitSha: commitSha,
      });
      this.syncStore.completeSync(syncId, files.length, allChunks.length);
      this.logger.info(`Indexed ${allChunks.length} chunks from ${files.length} files`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.config.updateDataSource(dataSourceId, {
        status: 'error',
        errorMessage: message,
      });
      this.syncStore.failSync(syncId, message);
      this.logger.error(`Indexing failed for ${ds.owner}/${ds.repo}: ${message}`);
    }
  }

  private async embedChunks(
    chunks: ChunkRecord[],
    provider: EmbeddingProvider,
  ): Promise<void> {
    const batchSize = provider.maxBatchSize;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await provider.embed(texts);

      const items = batch.map((chunk, idx) => ({
        chunkId: chunk.id,
        embedding: embeddings[idx],
      }));
      this.embeddingStore.insertMany(items);
    }
  }

  async removeDataSource(dataSourceId: string): Promise<void> {
    const chunkIds = this.chunkStore.getChunkIdsByDataSource(dataSourceId);
    this.embeddingStore.deleteByChunkIds(chunkIds);
    this.chunkStore.deleteByDataSource(dataSourceId);
  }

  dispose(): void {
    this.queue.length = 0;
  }
}

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'path';
import * as fs from 'fs';

const SCHEMA_VERSION = 2;
const DEFAULT_DIMENSIONS = 1536;

export interface OpenDatabaseOptions {
  /** Directory to store the DB file. If omitted, uses an in-memory DB. */
  storagePath?: string;
  /** Embedding dimensions for the vec0 table. Defaults to 1536. */
  dimensions?: number;
}

export function openDatabase(options: OpenDatabaseOptions = {}): Database.Database {
  let db: Database.Database;

  if (options.storagePath) {
    if (!fs.existsSync(options.storagePath)) {
      fs.mkdirSync(options.storagePath, { recursive: true });
    }
    const dbPath = path.join(options.storagePath, 'repolens.db');
    db = new Database(dbPath);
  } else {
    db = new Database(':memory:');
  }

  // Enable WAL mode for better concurrent read performance (no-op for :memory:)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  migrate(db, options.dimensions ?? DEFAULT_DIMENSIONS);
  return db;
}

function migrate(db: Database.Database, dimensions: number): void {
  const currentVersion = getSchemaVersion(db);

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )`,
    );

    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dimensions', ?)",
    ).run(dimensions.toString());
  }

  if (currentVersion < 2) {
    // Drop old tables that had broken FK constraints referencing data_sources.
    // data_sources is managed via repolens.json, not SQLite, so FK references are wrong.
    db.exec(`
      DROP TABLE IF EXISTS sync_history;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS data_sources;

      CREATE TABLE IF NOT EXISTS chunks (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        content         TEXT NOT NULL,
        token_count     INTEGER NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_data_source ON chunks(data_source_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(data_source_id, file_path);

      CREATE TABLE IF NOT EXISTS sync_history (
        id              TEXT PRIMARY KEY,
        data_source_id  TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        status          TEXT NOT NULL,
        files_processed INTEGER DEFAULT 0,
        chunks_created  INTEGER DEFAULT 0,
        error_message   TEXT,
        commit_sha      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_history_ds ON sync_history(data_source_id);
    `);

    setSchemaVersion(db, SCHEMA_VERSION);
  }
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(version.toString());
}

export function getEmbeddingDimensions(db: Database.Database): number {
  const row = db.prepare(
    "SELECT value FROM meta WHERE key = 'embedding_dimensions'",
  ).get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : DEFAULT_DIMENSIONS;
}

/**
 * Drop and recreate the embeddings vec0 table with new dimensions.
 * All existing embeddings are lost — callers must re-index.
 */
export function recreateEmbeddingsTable(db: Database.Database, dimensions: number): void {
  db.exec('DROP TABLE IF EXISTS embeddings');
  db.exec(
    `CREATE VIRTUAL TABLE embeddings USING vec0(
      chunk_id TEXT PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    )`,
  );
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dimensions', ?)",
  ).run(dimensions.toString());
}

import { describe, it, expect } from 'vitest';
import { Chunker } from '../../../src/ingestion/chunker';

// Simple tokenizer: 1 token per word (split on whitespace)
const wordCount = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

describe('Chunker', () => {
  it('returns empty array for empty content', () => {
    const chunker = new Chunker();
    expect(chunker.chunkFile('', 'test.ts')).toEqual([]);
  });

  it('returns a single chunk for small files', () => {
    const chunker = new Chunker({ maxTokens: 100, overlapTokens: 10 });
    const content = 'line one\nline two\nline three';
    const chunks = chunker.chunkFile(content, 'small.ts');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  it('splits large files into multiple chunks', () => {
    // 10 tokens per chunk, word-based counting
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    // 5 words per line × 6 lines = 30 words → should produce 3 chunks
    const lines = Array.from({ length: 6 }, (_, i) => `word1 word2 word3 word4 line${i}`);
    const content = lines.join('\n');
    const chunks = chunker.chunkFile(content, 'big.ts');

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // All content should be covered
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it('produces overlapping chunks', () => {
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 5,
      countTokens: wordCount,
    });

    // 5 words per line × 4 lines = 20 words
    const lines = [
      'alpha bravo charlie delta echo',
      'foxtrot golf hotel india juliet',
      'kilo lima mike november oscar',
      'papa quebec romeo sierra tango',
    ];
    const content = lines.join('\n');
    const chunks = chunker.chunkFile(content, 'overlap.ts');

    // With overlap, later chunks should start before the previous chunk ended
    if (chunks.length >= 2) {
      expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine + 1);
    }
  });

  it('uses 1-based line numbers', () => {
    const chunker = new Chunker({ maxTokens: 1000, overlapTokens: 0 });
    const content = 'first\nsecond\nthird';
    const chunks = chunker.chunkFile(content, 'test.ts');

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
  });

  it('reports token count per chunk', () => {
    const chunker = new Chunker({
      maxTokens: 10,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    const content = 'one two three four five\nsix seven eight nine ten\neleven twelve';
    const chunks = chunker.chunkFile(content, 'test.ts');

    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
      expect(chunk.tokenCount).toBeLessThanOrEqual(12); // small margin
    }
  });

  it('never produces empty chunks', () => {
    const chunker = new Chunker({
      maxTokens: 5,
      overlapTokens: 2,
      countTokens: wordCount,
    });

    const lines = Array.from({ length: 20 }, (_, i) => `word${i} another${i}`);
    const content = lines.join('\n');
    const chunks = chunker.chunkFile(content, 'test.ts');

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it('guarantees forward progress even with very small maxTokens', () => {
    const chunker = new Chunker({
      maxTokens: 1,
      overlapTokens: 0,
      countTokens: wordCount,
    });

    const content = 'hello world\nfoo bar';
    const chunks = chunker.chunkFile(content, 'test.ts');

    // Should not infinite loop, and should cover all lines
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(2);
  });

  it('handles single-line files', () => {
    const chunker = new Chunker({ maxTokens: 100, overlapTokens: 10 });
    const chunks = chunker.chunkFile('single line content', 'one.ts');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
  });

  it('uses default char/4 tokenizer when no countTokens provided', () => {
    const chunker = new Chunker({ maxTokens: 10, overlapTokens: 0 });
    // 40 chars = ~10 tokens with char/4 estimate
    const content = 'a'.repeat(40) + '\n' + 'b'.repeat(40);
    const chunks = chunker.chunkFile(content, 'test.ts');

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Chunker — file-level strategy', () => {
  it('returns a single chunk for the entire file', () => {
    const chunker = new Chunker({ strategy: 'file-level', maxTokens: 10 });
    const content = 'line one\nline two\nline three\nline four\nline five';
    const chunks = chunker.chunkFile(content, 'action.yml');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  it('returns empty array for empty content', () => {
    const chunker = new Chunker({ strategy: 'file-level' });
    expect(chunker.chunkFile('', 'empty.yml')).toEqual([]);
  });

  it('reports correct token count for a single-chunk file', () => {
    const chunker = new Chunker({
      strategy: 'file-level',
      countTokens: wordCount,
    });
    const content = 'alpha bravo charlie\ndelta echo foxtrot';
    const chunks = chunker.chunkFile(content, 'wf.yml');

    expect(chunks[0].tokenCount).toBe(6);
  });
});

describe('Chunker — markdown-heading strategy', () => {
  it('splits content on # headings', () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = [
      '# Introduction',
      'Some intro text.',
      '',
      '# Usage',
      'Usage details here.',
    ].join('\n');

    const chunks = chunker.chunkFile(content, 'README.md');

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('# Introduction');
    expect(chunks[1].content).toContain('# Usage');
  });

  it('uses 1-based line numbers relative to the original file', () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = '# First\nfirst body\n# Second\nsecond body';
    const chunks = chunker.chunkFile(content, 'doc.md');

    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(2);
    expect(chunks[1].startLine).toBe(3);
    expect(chunks[1].endLine).toBe(4);
  });

  it('sub-chunks oversized sections with token-split and preserves line offsets', () => {
    const chunker = new Chunker({
      strategy: 'markdown-heading',
      maxTokens: 3,
      overlapTokens: 0,
      countTokens: wordCount,
    });
    // Section has 9 words → exceeds maxTokens 3 → sub-chunked into 3 pieces
    const content = [
      '# Big Section',
      'one two three',
      'four five six',
      'seven eight nine',
    ].join('\n');

    const chunks = chunker.chunkFile(content, 'big.md');

    expect(chunks.length).toBeGreaterThan(1);
    // All sub-chunk startLines should be >= 1 (file-relative)
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
    // Last chunk should end at line 4
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(4);
  });

  it('handles files with no headings as a single section', () => {
    const chunker = new Chunker({ strategy: 'markdown-heading', maxTokens: 1000 });
    const content = 'No headings here.\nJust plain text.\n';
    const chunks = chunker.chunkFile(content, 'plain.md');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
  });

  it('returns empty array for empty content', () => {
    const chunker = new Chunker({ strategy: 'markdown-heading' });
    expect(chunker.chunkFile('', 'empty.md')).toEqual([]);
  });
});

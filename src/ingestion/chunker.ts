export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export type ChunkingStrategy = 'token-split' | 'file-level' | 'markdown-heading';

export interface ChunkerOptions {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
  strategy: ChunkingStrategy;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 64;
const DEFAULT_COUNT_TOKENS = (text: string): number => Math.ceil(text.length / 4);

export class Chunker {
  private readonly maxTokens: number;
  private readonly overlapTokens: number;
  private readonly countTokens: (text: string) => number;
  private readonly strategy: ChunkingStrategy;

  constructor(options?: Partial<ChunkerOptions>) {
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    this.countTokens = options?.countTokens ?? DEFAULT_COUNT_TOKENS;
    this.strategy = options?.strategy ?? 'token-split';
  }

  chunkFile(content: string, filePath: string): Chunk[] {
    if (!content) return [];
    if (this.strategy === 'file-level') return this.chunkAsWhole(content);
    if (this.strategy === 'markdown-heading') return this.chunkByHeadings(content);
    return this.chunkByTokens(content, filePath);
  }

  // One chunk spanning the entire file. Used for action.yml and workflow files
  // where each file is a self-contained semantic unit.
  private chunkAsWhole(content: string): Chunk[] {
    const lines = content.split('\n');
    return [{
      content,
      startLine: 1,
      endLine: lines.length,
      tokenCount: this.countTokens(content),
    }];
  }

  // Split on Markdown headings (lines starting with '#'). Each heading and its
  // following content becomes one chunk. Sections that exceed maxTokens are
  // sub-chunked with the token-split strategy.
  private chunkByHeadings(content: string): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];

    // Collect sections: each entry is [startIdx, lines[]]
    const sections: Array<{ startIdx: number; lines: string[] }> = [];
    let sectionStart = 0;
    let sectionLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const isHeading = lines[i].startsWith('#');
      if (isHeading && sectionLines.length > 0) {
        sections.push({ startIdx: sectionStart, lines: sectionLines });
        sectionStart = i;
        sectionLines = [];
      }
      sectionLines.push(lines[i]);
    }
    if (sectionLines.length > 0) {
      sections.push({ startIdx: sectionStart, lines: sectionLines });
    }

    for (const section of sections) {
      const sectionContent = section.lines.join('\n');
      const tokenCount = this.countTokens(sectionContent);

      if (tokenCount <= this.maxTokens) {
        chunks.push({
          content: sectionContent,
          startLine: section.startIdx + 1,
          endLine: section.startIdx + section.lines.length,
          tokenCount,
        });
      } else {
        // Section is too large — sub-chunk with token-split and adjust line numbers
        const subChunks = this.chunkByTokens(sectionContent, '', section.startIdx);
        chunks.push(...subChunks);
      }
    }

    return chunks;
  }

  // Greedy token-based chunking with overlap. lineOffset shifts output line
  // numbers when chunking a sub-section of a larger file (used by chunkByHeadings).
  private chunkByTokens(content: string, _filePath: string, lineOffset: number = 0): Chunk[] {
    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    let startIdx = 0;

    while (startIdx < lines.length) {
      let endIdx = startIdx;
      let currentTokens = 0;

      // Expand chunk line by line until we hit the token limit
      while (endIdx < lines.length) {
        const lineText = endIdx < lines.length - 1 ? lines[endIdx] + '\n' : lines[endIdx];
        const lineTokens = this.countTokens(lineText);

        if (currentTokens + lineTokens > this.maxTokens && endIdx > startIdx) {
          break;
        }
        currentTokens += lineTokens;
        endIdx++;
      }

      const chunkContent = lines.slice(startIdx, endIdx).join('\n');
      chunks.push({
        content: chunkContent,
        startLine: lineOffset + startIdx + 1, // 1-based
        endLine: lineOffset + endIdx,          // 1-based, inclusive
        tokenCount: currentTokens,
      });

      if (endIdx >= lines.length) break;

      // Compute overlap: walk backwards from endIdx to find how many
      // lines fit within overlapTokens
      const overlapStart = this.findOverlapStart(lines, endIdx, this.overlapTokens);
      startIdx = overlapStart;

      // Guarantee forward progress
      if (startIdx <= chunks[chunks.length - 1].startLine - lineOffset - 1) {
        startIdx = endIdx;
      }
    }

    return chunks;
  }

  private findOverlapStart(lines: string[], endIdx: number, overlapTokens: number): number {
    let tokens = 0;
    let idx = endIdx;
    while (idx > 0) {
      idx--;
      const lineText = idx < lines.length - 1 ? lines[idx] + '\n' : lines[idx];
      tokens += this.countTokens(lineText);
      if (tokens >= overlapTokens) break;
    }
    return idx;
  }
}

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export interface ChunkerOptions {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 64;
const DEFAULT_COUNT_TOKENS = (text: string): number => Math.ceil(text.length / 4);

export class Chunker {
  private readonly maxTokens: number;
  private readonly overlapTokens: number;
  private readonly countTokens: (text: string) => number;

  constructor(options?: Partial<ChunkerOptions>) {
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    this.countTokens = options?.countTokens ?? DEFAULT_COUNT_TOKENS;
  }

  chunkFile(content: string, _filePath: string): Chunk[] {
    if (!content) return [];

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
        startLine: startIdx + 1, // 1-based
        endLine: endIdx,         // 1-based, inclusive
        tokenCount: currentTokens,
      });

      if (endIdx >= lines.length) break;

      // Compute overlap: walk backwards from endIdx to find how many
      // lines fit within overlapTokens
      const overlapStart = this.findOverlapStart(lines, endIdx, this.overlapTokens);
      startIdx = overlapStart;

      // Guarantee forward progress
      if (startIdx <= chunks[chunks.length - 1].startLine - 1) {
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

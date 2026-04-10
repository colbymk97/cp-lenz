import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { EmbeddingProviderRegistry } from '../embedding/registry';
import { Retriever } from '../retrieval/retriever';
import { ContextBuilder } from '../retrieval/contextBuilder';
import { GitHubFetcher } from '../sources/github/githubFetcher';
import { SETTING_KEYS } from '../config/settingsSchema';

const MAX_LINES = 3000;
const MAX_CHARS = 80_000;

export class ToolHandler {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly providerRegistry: EmbeddingProviderRegistry,
    private readonly retriever: Retriever,
    private readonly contextBuilder: ContextBuilder,
    private readonly fetcher: GitHubFetcher,
  ) {}

  async handle(
    toolId: string,
    options: vscode.LanguageModelToolInvocationOptions<{ query: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const tool = this.configManager.getTool(toolId);
    if (!tool) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Tool "${toolId}" not found.`),
      ]);
    }

    return this.executeSearch(options.input.query, tool.dataSourceIds);
  }

  async handleGlobalSearch(
    options: vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const readySources = this.configManager
      .getDataSources()
      .filter((ds) => ds.status === 'ready');

    if (readySources.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'No repositories are indexed yet. Add a repository via the RepoLens sidebar and wait for indexing to complete.',
        ),
      ]);
    }

    let targetIds: string[];
    const repoFilter = options.input.repository?.toLowerCase();

    if (repoFilter) {
      const matched = readySources.filter(
        (ds) =>
          `${ds.owner}/${ds.repo}`.toLowerCase() === repoFilter ||
          ds.repo.toLowerCase() === repoFilter,
      );
      if (matched.length === 0) {
        const available = readySources.map((ds) => `${ds.owner}/${ds.repo}`).join(', ');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(
            `Repository "${options.input.repository}" is not indexed. Indexed repositories: ${available}`,
          ),
        ]);
      }
      targetIds = matched.map((ds) => ds.id);
    } else {
      targetIds = readySources.map((ds) => ds.id);
    }

    const searchedRepos = readySources
      .filter((ds) => targetIds.includes(ds.id))
      .map((ds) => `${ds.owner}/${ds.repo}`)
      .join(', ');

    return this.executeSearch(options.input.query, targetIds, searchedRepos);
  }

  async handleGetFile(
    options: vscode.LanguageModelToolInvocationOptions<{
      repository: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
    }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { repository, filePath, startLine, endLine } = options.input;

    const ds = this.configManager
      .getDataSources()
      .find((s) => `${s.owner}/${s.repo}`.toLowerCase() === repository.toLowerCase());

    if (!ds) {
      const available = this.configManager
        .getDataSources()
        .map((s) => `${s.owner}/${s.repo}`)
        .join(', ') || 'none';
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Repository "${repository}" is not indexed. Indexed repositories: ${available}`,
        ),
      ]);
    }

    try {
      const raw = await this.fetcher.getFileContents(ds.owner, ds.repo, filePath, ds.branch);
      const lines = raw.split('\n');
      const totalLines = lines.length;

      let sliced: string[];
      let rangeStart: number;
      let rangeEnd: number;
      let truncated = false;

      if (startLine !== undefined && endLine !== undefined) {
        rangeStart = Math.max(1, startLine);
        rangeEnd = Math.min(totalLines, endLine);
        sliced = lines.slice(rangeStart - 1, rangeEnd);
      } else {
        rangeStart = 1;
        let charCount = 0;
        let cutAt = lines.length;
        for (let i = 0; i < lines.length; i++) {
          charCount += lines[i].length + 1;
          if (i + 1 === MAX_LINES || charCount >= MAX_CHARS) {
            cutAt = i + 1;
            break;
          }
        }
        truncated = cutAt < totalLines;
        sliced = lines.slice(0, cutAt);
        rangeEnd = cutAt;
      }

      const lang = langHint(filePath);
      const header =
        `**${ds.owner}/${ds.repo}** · Branch: \`${ds.branch}\` · \`${filePath}\`\n` +
        `Lines ${rangeStart}–${rangeEnd} of ${totalLines}`;
      const body = `\`\`\`${lang}\n${sliced.join('\n')}\n\`\`\``;
      const notice = truncated
        ? `\n[File truncated — showing lines 1–${rangeEnd} of ${totalLines}. ` +
          `Call again with startLine/endLine to fetch a specific range.]`
        : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`${header}\n\n${body}${notice}`),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(message),
      ]);
    }
  }

  private async executeSearch(
    query: string,
    dataSourceIds: string[],
    searchedRepos?: string,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const topK = vscode.workspace
        .getConfiguration()
        .get<number>(SETTING_KEYS.SEARCH_TOP_K, 10);

      const provider = await this.providerRegistry.getProvider();
      const results = await this.retriever.search(query, dataSourceIds, provider, topK);
      const formatted = this.contextBuilder.format(results);

      const header = searchedRepos
        ? `*Searched repositories: ${searchedRepos}*\n\n`
        : '';

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(header + formatted),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Search failed: ${message}`),
      ]);
    }
  }
}

function langHint(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return '';
  const ext = filePath.slice(dot + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'py', rb: 'rb', go: 'go', rs: 'rs',
    java: 'java', kt: 'kt', cs: 'cs', cpp: 'cpp', c: 'c', h: 'h',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'md', html: 'html', css: 'css', scss: 'scss',
    sh: 'sh', bash: 'sh', zsh: 'sh',
    sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? '';
}

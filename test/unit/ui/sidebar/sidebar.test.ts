import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: any;
    collapsibleState?: number;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(public id: string, public color?: any) {}
  },
  ThemeColor: class {
    constructor(public id: string) {}
  },
  EventEmitter: class {
    private listeners: Array<(e: any) => void> = [];
    event = (listener: (e: any) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(data: any) { this.listeners.forEach((l) => l(data)); }
    dispose() {}
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, defaultValue?: any) => defaultValue }),
  },
}));

import {
  DataSourceTypeGroupItem,
  DataSourceTreeItem,
  DataSourceInfoItem,
  DataSourceFileItem,
  EmbeddingTreeItem,
} from '../../../../src/ui/sidebar/sidebarTreeItems';
import {
  DataSourceTreeProvider,
  EmbeddingTreeProvider,
  groupDataSourcesByType,
} from '../../../../src/ui/sidebar/sidebarProvider';
import { DataSourceConfig } from '../../../../src/config/configSchema';

function makeDs(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: 'ds-1', repoUrl: '', owner: 'acme', repo: 'widgets', branch: 'main',
    type: 'documentation',
    includePatterns: [], excludePatterns: [], syncSchedule: 'manual',
    lastSyncedAt: null, lastSyncCommitSha: null, status: 'ready',
    ...overrides,
  };
}

describe('DataSourceTreeItem', () => {
  it('displays owner/repo as label', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.label).toBe('acme/widgets');
  });

  it('shows branch in description', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.description).toContain('main');
  });

  it('shows status icon for ready state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'ready' }));
    expect(item.description).toContain('$(check)');
  });

  it('shows status icon for error state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'error', errorMessage: 'fail' }));
    expect(item.description).toContain('$(error)');
    expect(item.tooltip).toContain('fail');
  });

  it('shows status icon for indexing state', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    expect(item.description).toContain('$(sync~spin)');
  });

  it('shows last synced time in tooltip', () => {
    const item = new DataSourceTreeItem(makeDs({ lastSyncedAt: '2025-01-01T00:00:00Z' }));
    expect(item.tooltip).toContain('2025-01-01');
  });

  it('sets contextValue to dataSource', () => {
    const item = new DataSourceTreeItem(makeDs());
    expect(item.contextValue).toBe('dataSource');
  });

  it('shows deleting state with a spinner and disabled context', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'deleting' }));
    expect(item.description).toBe('$(sync~spin) Deleting...');
    expect(item.contextValue).toBe('dataSourceDeleting');
    expect(item.tooltip).toContain('Status: Deleting');
    expect((item.iconPath as any).id).toBe('loading~spin');
  });

  it('is collapsible when status is ready', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'ready' }));
    expect(item.collapsibleState).toBe(1); // Collapsed
  });

  it('is not collapsible when status is indexing', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    expect(item.collapsibleState).toBe(0); // None
  });

  it('is collapsible when partially indexed during indexing', () => {
    const item = new DataSourceTreeItem(
      makeDs({ status: 'indexing' }),
      undefined,
      { fileCount: 2, chunkCount: 4, totalTokens: 120 },
    );
    expect(item.collapsibleState).toBe(1); // Collapsed
    expect(item.description).toContain('partial');
  });

  it('is not collapsible when status is error', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'error' }));
    expect(item.collapsibleState).toBe(0); // None
  });

  it('is not collapsible when status is queued', () => {
    const item = new DataSourceTreeItem(makeDs({ status: 'queued' }));
    expect(item.collapsibleState).toBe(0); // None
  });

  it('is not collapsible while deleting even with indexed chunks', () => {
    const item = new DataSourceTreeItem(
      makeDs({ status: 'deleting' }),
      undefined,
      { fileCount: 2, chunkCount: 4, totalTokens: 120 },
    );
    expect(item.collapsibleState).toBe(0); // None
  });
});

describe('DataSourceInfoItem', () => {
  it('displays stats in label', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 12, chunkCount: 87, totalTokens: 4230 },
      makeDs(),
    );
    expect(item.label).toContain('12');
    expect(item.label).toContain('87');
    expect(item.label).toContain('4,230');
  });

  it('sets contextValue to dataSourceInfo', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs(),
    );
    expect(item.contextValue).toBe('dataSourceInfo');
  });

  it('includes commit SHA in tooltip when available', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs({ lastSyncCommitSha: 'abc1234567890' }),
    );
    expect(item.tooltip).toContain('abc1234');
  });

  it('is not collapsible', () => {
    const item = new DataSourceInfoItem(
      { fileCount: 1, chunkCount: 1, totalTokens: 10 },
      makeDs(),
    );
    expect(item.collapsibleState).toBe(0); // None
  });
});

describe('DataSourceFileItem', () => {
  it('displays file path as label', () => {
    const item = new DataSourceFileItem({ filePath: 'src/index.ts', chunkCount: 3, tokenCount: 150 });
    expect(item.label).toBe('src/index.ts');
  });

  it('shows chunk count in description', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 5, tokenCount: 100 });
    expect(item.description).toBe('5 chunks');
  });

  it('singularizes chunk count of 1', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.description).toBe('1 chunk');
  });

  it('sets contextValue to dataSourceFile', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.contextValue).toBe('dataSourceFile');
  });

  it('is not collapsible', () => {
    const item = new DataSourceFileItem({ filePath: 'a.ts', chunkCount: 1, tokenCount: 50 });
    expect(item.collapsibleState).toBe(0); // None
  });
});


describe('DataSourceTypeGroupItem', () => {
  it('renders an unknown repo type without crashing', () => {
    const item = new DataSourceTypeGroupItem('made-up-type' as any, 2);
    expect(item.label).toBe('Made Up Type');
    expect(item.description).toBe('2');
    expect((item.iconPath as any).id).toBe('folder');
    expect(item.tooltip).toContain('Made Up Type');
  });

  it('uses preset displayName for known types', () => {
    const item = new DataSourceTypeGroupItem('documentation', 1);
    expect(item.label).toBe('Documentation / standards');
    expect(item.description).toBe('1');
  });
});

describe('groupDataSourcesByType', () => {
  it('orders preset types in the canonical order and drops empty ones', () => {
    const result = groupDataSourcesByType([
      makeDs({ id: '1', type: 'general' }),
      makeDs({ id: '2', type: 'documentation' }),
      makeDs({ id: '3', type: 'github-actions-library' }),
      makeDs({ id: '4', type: 'cicd-workflows' }),
    ]);

    expect(result.map((g) => g.type)).toEqual([
      'documentation',
      'cicd-workflows',
      'github-actions-library',
      'general',
    ]);
  });

  it('sorts repos within a group alphabetically by owner/repo', () => {
    const result = groupDataSourcesByType([
      makeDs({ id: '1', type: 'documentation', owner: 'z', repo: 'z' }),
      makeDs({ id: '2', type: 'documentation', owner: 'a', repo: 'a' }),
      makeDs({ id: '3', type: 'documentation', owner: 'a', repo: 'b' }),
    ]);

    expect(result[0].sources.map((d) => `${d.owner}/${d.repo}`)).toEqual([
      'a/a', 'a/b', 'z/z',
    ]);
  });
});

describe('DataSourceTreeProvider', () => {
  function makeChunkStore(stats = { fileCount: 0, chunkCount: 0, totalTokens: 0 }, fileStats: any[] = []) {
    return {
      getDataSourceStats: vi.fn().mockReturnValue(stats),
      getFileStats: vi.fn().mockReturnValue(fileStats),
    } as any;
  }

  function makeProgressTracker() {
    return {
      get: vi.fn().mockReturnValue(undefined),
      onDidChange: (cb: () => void) => { return { dispose: vi.fn() }; },
    } as any;
  }

  it('returns type-group items at root, ordered docs/workflows/actions first', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [
        makeDs({ id: 'ds-actions', type: 'github-actions-library', repo: 'actions' }),
        makeDs({ id: 'ds-docs', type: 'documentation', repo: 'docs' }),
        makeDs({ id: 'ds-cicd', type: 'cicd-workflows', repo: 'pipelines' }),
      ],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const children = provider.getChildren();

    expect(children).toHaveLength(3);
    expect(children[0]).toBeInstanceOf(DataSourceTypeGroupItem);
    expect((children[0] as DataSourceTypeGroupItem).type).toBe('documentation');
    expect((children[1] as DataSourceTypeGroupItem).type).toBe('cicd-workflows');
    expect((children[2] as DataSourceTypeGroupItem).type).toBe('github-actions-library');
  });

  it('omits type groups that have no data sources', () => {
    const configManager = {
      getDataSources: () => [makeDs({ type: 'documentation' })],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const children = provider.getChildren();

    expect(children).toHaveLength(1);
    expect((children[0] as DataSourceTypeGroupItem).type).toBe('documentation');
    expect(children[0].description).toBe('1');
  });

  it('expands a type-group node into its data sources', () => {
    const configManager = {
      getDataSources: () => [
        makeDs({ id: 'ds-1', type: 'documentation', owner: 'b', repo: 'beta' }),
        makeDs({ id: 'ds-2', type: 'documentation', owner: 'a', repo: 'alpha' }),
        makeDs({ id: 'ds-other', type: 'cicd-workflows', repo: 'wf' }),
      ],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const group = new DataSourceTypeGroupItem('documentation', 2);
    const children = provider.getChildren(group);

    expect(children).toHaveLength(2);
    expect(children[0].label).toBe('a/alpha');
    expect(children[1].label).toBe('b/beta');
  });

  it('returns info and file items when expanding a ready data source', () => {
    const configManager = {
      getDataSources: () => [makeDs()],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const chunkStore = makeChunkStore(
      { fileCount: 2, chunkCount: 5, totalTokens: 200 },
      [
        { filePath: 'a.ts', chunkCount: 3, tokenCount: 120 },
        { filePath: 'b.ts', chunkCount: 2, tokenCount: 80 },
      ],
    );

    const provider = new DataSourceTreeProvider(configManager, chunkStore, makeProgressTracker());
    const dsItem = new DataSourceTreeItem(makeDs());
    const children = provider.getChildren(dsItem);

    expect(children).toHaveLength(3);
    expect(children[0]).toBeInstanceOf(DataSourceInfoItem);
    expect(children[1]).toBeInstanceOf(DataSourceFileItem);
    expect(children[2]).toBeInstanceOf(DataSourceFileItem);
    expect(children[1].label).toBe('a.ts');
    expect(children[2].label).toBe('b.ts');
  });

  it('returns empty array for non-ready data source children', () => {
    const configManager = {
      getDataSources: () => [],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const dsItem = new DataSourceTreeItem(makeDs({ status: 'indexing' }));
    const children = provider.getChildren(dsItem);

    expect(children).toHaveLength(0);
  });

  it('returns info and file items for partial data sources with indexed chunks', () => {
    const configManager = {
      getDataSources: () => [],
      onDidChange: () => ({ dispose: vi.fn() }),
    } as any;

    const chunkStore = makeChunkStore(
      { fileCount: 1, chunkCount: 2, totalTokens: 50 },
      [{ filePath: 'docs/readme.md', chunkCount: 2, tokenCount: 50 }],
    );

    const provider = new DataSourceTreeProvider(configManager, chunkStore, makeProgressTracker());
    const dsItem = new DataSourceTreeItem(
      makeDs({ status: 'error', errorMessage: 'transport failed' }),
      undefined,
      { fileCount: 1, chunkCount: 2, totalTokens: 50 },
    );
    const children = provider.getChildren(dsItem);

    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(DataSourceInfoItem);
    expect(children[1]).toBeInstanceOf(DataSourceFileItem);
  });

  it('fires onDidChangeTreeData on config change', () => {
    const changeCallbacks: Array<() => void> = [];
    const configManager = {
      getDataSources: () => [],
      onDidChange: (cb: () => void) => { changeCallbacks.push(cb); return { dispose: vi.fn() }; },
    } as any;

    const provider = new DataSourceTreeProvider(configManager, makeChunkStore(), makeProgressTracker());
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);

    changeCallbacks.forEach((cb) => cb());
    expect(listener).toHaveBeenCalled();
  });
});

describe('EmbeddingTreeItem', () => {
  it('shows configured state with green icon when connection succeeded', () => {
    const item = new EmbeddingTreeItem({
      provider: 'openai',
      providerLabel: 'OpenAI',
      identifier: 'text-embedding-3-small',
      identifierLabel: 'Model',
      dimensions: 1536,
      requiresApiKey: true,
      hasApiKey: true,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-openai',
      isRebuilding: false,
      isStale: false,
      statusLabel: 'Configured',
      actionCommand: 'yoink.manageEmbeddings',
      tooltip: 'configured',
      connectionStatus: 'success',
    });

    expect(item.label).toBe('OpenAI: text-embedding-3-small');
    expect(item.description).toContain('Configured');
    expect(item.contextValue).toBe('embeddingReady');
    expect(item.command?.command).toBe('yoink.manageEmbeddings');
    expect((item.iconPath as any).id).toBe('circle-filled');
    expect((item.iconPath as any).color?.id).toBe('testing.runAction');
  });

  it('shows red circle when connection test failed', () => {
    const item = new EmbeddingTreeItem({
      provider: 'openai',
      providerLabel: 'OpenAI',
      identifier: 'text-embedding-3-small',
      identifierLabel: 'Model',
      dimensions: 1536,
      requiresApiKey: true,
      hasApiKey: true,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-openai',
      isRebuilding: false,
      isStale: false,
      statusLabel: 'Configured',
      actionCommand: 'yoink.manageEmbeddings',
      tooltip: 'configured',
      connectionStatus: 'failed',
      connectionError: 'auth failed',
    });

    expect((item.iconPath as any).id).toBe('circle-filled');
    expect((item.iconPath as any).color?.id).toBe('errorForeground');
  });

  it('falls back to neutral icon when connection status is unknown', () => {
    const item = new EmbeddingTreeItem({
      provider: 'local',
      providerLabel: 'Local',
      identifier: 'nomic-embed-text',
      identifierLabel: 'Model',
      dimensions: 768,
      requiresApiKey: false,
      hasApiKey: false,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-local',
      isRebuilding: false,
      isStale: false,
      statusLabel: 'Configured',
      actionCommand: 'yoink.manageEmbeddings',
      tooltip: 'configured',
      connectionStatus: 'unknown',
    });

    expect((item.iconPath as any).id).toBe('symbol-misc');
  });

  it('shows stale state as rebuildable', () => {
    const item = new EmbeddingTreeItem({
      provider: 'azure-openai',
      providerLabel: 'Azure OpenAI',
      identifier: 'embed-prod',
      identifierLabel: 'Deployment',
      dimensions: 3072,
      requiresApiKey: true,
      hasApiKey: true,
      missingFields: [],
      isConfigured: true,
      fingerprint: 'fp-azure',
      isRebuilding: false,
      isStale: true,
      statusLabel: 'Rebuild required',
      actionCommand: 'yoink.rebuildEmbeddings',
      tooltip: 'rebuild required',
      connectionStatus: 'success',
    });

    expect(item.description).toContain('Rebuild required');
    expect(item.contextValue).toBe('embeddingStale');
    expect(item.command?.command).toBe('yoink.rebuildEmbeddings');
    expect((item.iconPath as any).id).toBe('warning');
  });
});

describe('EmbeddingTreeProvider', () => {
  it('returns the embedding status item', async () => {
    const embeddingManager = {
      getStatus: vi.fn().mockResolvedValue({
        provider: 'local',
        providerLabel: 'Local',
        identifier: 'nomic-embed-text',
        identifierLabel: 'Model',
        dimensions: 768,
        requiresApiKey: false,
        hasApiKey: false,
        missingFields: [],
        isConfigured: true,
        fingerprint: 'fp-local',
        isRebuilding: false,
        isStale: false,
        statusLabel: 'Configured',
        actionCommand: 'yoink.manageEmbeddings',
        tooltip: 'configured',
        connectionStatus: 'success',
      }),
      onDidChange: (listener: () => void) => ({ dispose: vi.fn() }),
    } as any;

    const provider = new EmbeddingTreeProvider(embeddingManager);
    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmbeddingTreeItem);
    expect(children[0].label).toBe('Local: nomic-embed-text');
  });
});

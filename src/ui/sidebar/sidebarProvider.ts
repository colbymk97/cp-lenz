import * as vscode from 'vscode';
import { ConfigManager } from '../../config/configManager';
import {
  SidebarTreeItem,
  DataSourceTypeGroupItem,
  DataSourceTreeItem,
  DataSourceInfoItem,
  DataSourceFileItem,
  EmbeddingTreeItem,
} from './sidebarTreeItems';
import { SETTING_KEYS } from '../../config/settingsSchema';
import { ChunkStore } from '../../storage/chunkStore';
import { ProgressTracker } from '../../ingestion/progressTracker';
import { EmbeddingManager } from '../../embedding/manager';
import { DataSourceConfig } from '../../config/configSchema';
import { DataSourceType } from '../../config/repoTypePresets';

const TYPE_GROUP_ORDER: DataSourceType[] = [
  'documentation',
  'cicd-workflows',
  'github-actions-library',
  'source-code',
  'general',
  'openapi-specs',
];

export function groupDataSourcesByType(
  sources: readonly DataSourceConfig[],
): Array<{ type: DataSourceType; sources: DataSourceConfig[] }> {
  const buckets = new Map<DataSourceType, DataSourceConfig[]>();
  for (const ds of sources) {
    const list = buckets.get(ds.type);
    if (list) {
      list.push(ds);
    } else {
      buckets.set(ds.type, [ds]);
    }
  }
  const groups: Array<{ type: DataSourceType; sources: DataSourceConfig[] }> = [];
  for (const type of TYPE_GROUP_ORDER) {
    const list = buckets.get(type);
    if (list && list.length > 0) {
      groups.push({ type, sources: sortRepos(list) });
      buckets.delete(type);
    }
  }
  for (const [type, list] of buckets) {
    if (list.length > 0) {
      groups.push({ type, sources: sortRepos(list) });
    }
  }
  return groups;
}

function sortRepos(list: DataSourceConfig[]): DataSourceConfig[] {
  return [...list].sort((a, b) =>
    `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
  );
}

export class DataSourceTreeProvider
  implements vscode.TreeDataProvider<SidebarTreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly chunkStore: ChunkStore,
    private readonly progressTracker: ProgressTracker,
  ) {
    configManager.onDidChange(() => this.refresh());
    progressTracker.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SidebarTreeItem): SidebarTreeItem[] {
    if (!element) {
      const groups = groupDataSourcesByType(this.configManager.getDataSources());
      return groups.map(
        (g) => new DataSourceTypeGroupItem(g.type, g.sources.length),
      );
    }

    if (element instanceof DataSourceTypeGroupItem) {
      const groups = groupDataSourcesByType(this.configManager.getDataSources());
      const group = groups.find((g) => g.type === element.type);
      if (!group) return [];
      return group.sources.map(
        (ds) => new DataSourceTreeItem(
          ds,
          this.progressTracker.get(ds.id),
          this.chunkStore.getDataSourceStats(ds.id),
        ),
      );
    }

    if (element instanceof DataSourceTreeItem) {
      const dsId = element.dataSource.id;
      const stats = this.chunkStore.getDataSourceStats(dsId);
      if (stats.fileCount === 0 && element.dataSource.status !== 'ready') {
        return [];
      }
      const fileStats = this.chunkStore.getFileStats(dsId);
      const model = vscode.workspace.getConfiguration().get<string>(
        SETTING_KEYS.OPENAI_MODEL, 'text-embedding-3-small',
      );

      return [
        new DataSourceInfoItem(stats, element.dataSource, model),
        ...fileStats.map((fs) => new DataSourceFileItem(fs)),
      ];
    }

    return [];
  }
}

export class EmbeddingTreeProvider implements vscode.TreeDataProvider<SidebarTreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SidebarTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly managerListener: vscode.Disposable;

  constructor(
    private readonly embeddingManager: EmbeddingManager,
  ) {
    this.managerListener = embeddingManager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SidebarTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<SidebarTreeItem[]> {
    return [new EmbeddingTreeItem(await this.embeddingManager.getStatus())];
  }

  dispose(): void {
    this.managerListener.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

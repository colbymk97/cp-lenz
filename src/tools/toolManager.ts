import * as vscode from 'vscode';
import { ToolHandler } from './toolHandler';
import { GET_FILE_TOOL } from './getFileTool';
import { Logger } from '../util/logger';

export class ToolManager implements vscode.Disposable {
  private readonly registeredTools = new Map<string, vscode.Disposable>();

  constructor(
    private readonly toolHandler: ToolHandler,
    private readonly logger: Logger,
  ) {}

  registerAll(): void {
    this.registerGlobalSearchTool();
    this.registerListTool();
    this.registerGetFileTool();
    this.syncRegistrations();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('yoink-search', {
      invoke: async (options, token) => {
        return this.toolHandler.handleGlobalSearch(
          options as vscode.LanguageModelToolInvocationOptions<{ query: string; repository?: string; tool?: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__global__', disposable);
    this.logger.info('Registered global search tool');
  }

  private registerListTool(): void {
    if (this.registeredTools.has('__list__')) return;
  }
  private registerGetFileTool(): void {
    if (this.registeredTools.has('__getfile__')) return;

    const disposable = vscode.lm.registerTool(GET_FILE_TOOL.name, {
      invoke: async (options, token) => {
        return this.toolHandler.handleGetFile(
          options as vscode.LanguageModelToolInvocationOptions<{
            repository: string;
            filePath: string;
            startLine?: number;
            endLine?: number;
          }>,
          token,
        );
      },
    });

    this.registeredTools.set('__getfile__', disposable);
    this.logger.info('Registered get file tool');
  }

  private syncRegistrations(): void {
    const configTools = this.configManager.getTools();
    const desiredNames = new Set(
      configTools.map((t) => this.registrationName(t.name)),
    );

    // Unregister tools no longer in config
    for (const [key, disposable] of this.registeredTools) {
      if (key === '__global__' || key === '__getfile__') continue;
      if (!desiredNames.has(key)) {
        disposable.dispose();
        this.registeredTools.delete(key);
        this.logger.info(`Unregistered tool: ${key}`);
      }
    }

    const disposable = vscode.lm.registerTool('yoink-list', {
      invoke: async (_options, token) => {
        return this.toolHandler.handleList(token);
      },
    });

    this.registeredTools.set('__list__', disposable);
    this.logger.info('Registered list tool');
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
  }
}

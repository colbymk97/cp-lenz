import * as vscode from 'vscode';
import { ConfigManager } from '../config/configManager';
import { ToolHandler } from './toolHandler';
import { GET_FILE_TOOL } from './getFileTool';
import { Logger } from '../util/logger';

export class ToolManager implements vscode.Disposable {
  private readonly registeredTools = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly configManager: ConfigManager,
    private readonly toolHandler: ToolHandler,
    private readonly logger: Logger,
  ) {
    // Re-sync tool registrations when config changes
    this.disposables.push(
      configManager.onDidChange(() => this.syncRegistrations()),
    );
  }

  registerAll(): void {
    this.registerGlobalSearchTool();
    this.registerGetFileTool();
    this.syncRegistrations();
  }

  private registerGlobalSearchTool(): void {
    if (this.registeredTools.has('__global__')) return;

    const disposable = vscode.lm.registerTool('repolens-search', {
      invoke: async (options, token) => {
        return this.toolHandler.handleGlobalSearch(
          options as vscode.LanguageModelToolInvocationOptions<{ query: string }>,
          token,
        );
      },
    });

    this.registeredTools.set('__global__', disposable);
    this.logger.info('Registered global search tool');
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

    // Register new tools from config
    for (const tool of configTools) {
      const name = this.registrationName(tool.name);
      if (!this.registeredTools.has(name)) {
        const toolId = tool.id;
        const disposable = vscode.lm.registerTool(name, {
          invoke: async (options, token) => {
            return this.toolHandler.handle(
              toolId,
              options as vscode.LanguageModelToolInvocationOptions<{ query: string }>,
              token,
            );
          },
        });
        this.registeredTools.set(name, disposable);
        this.logger.info(`Registered tool: ${name}`);
      }
    }
  }

  private registrationName(toolName: string): string {
    return `repolens-${toolName}`;
  }

  dispose(): void {
    for (const disposable of this.registeredTools.values()) {
      disposable.dispose();
    }
    this.registeredTools.clear();
    this.disposables.forEach((d) => d.dispose());
  }
}

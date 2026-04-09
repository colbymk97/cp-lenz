import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track registrations
const registeredTools = new Map<string, any>();
const disposedTools: string[] = [];

vi.mock('vscode', () => ({
  lm: {
    registerTool: vi.fn().mockImplementation((name: string, handler: any) => {
      registeredTools.set(name, handler);
      return {
        dispose: () => {
          disposedTools.push(name);
          registeredTools.delete(name);
        },
      };
    }),
  },
}));

import { ToolManager } from '../../../src/tools/toolManager';
import { ToolConfig } from '../../../src/config/configSchema';

function makeTool(id: string, name: string): ToolConfig {
  return { id, name, description: 'Test tool', dataSourceIds: ['ds-1'] };
}

describe('ToolManager', () => {
  let changeListeners: Array<() => void>;
  let configTools: ToolConfig[];
  let configManager: any;
  let toolHandler: any;
  let logger: any;

  beforeEach(() => {
    registeredTools.clear();
    disposedTools.length = 0;
    changeListeners = [];
    configTools = [];

    configManager = {
      getTools: () => configTools,
      onDidChange: (cb: () => void) => {
        changeListeners.push(cb);
        return { dispose: vi.fn() };
      },
    };

    toolHandler = {
      handle: vi.fn(),
      handleGlobalSearch: vi.fn(),
    };

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it('registerAll registers the global search tool', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-search')).toBe(true);
    manager.dispose();
  });

  it('registerAll registers config tools alongside global tool', () => {
    configTools = [makeTool('t-1', 'my-tool'), makeTool('t-2', 'other-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-search')).toBe(true);
    expect(registeredTools.has('repolens-my-tool')).toBe(true);
    expect(registeredTools.has('repolens-other-tool')).toBe(true);
    manager.dispose();
  });

  it('does not duplicate global tool on repeated registerAll calls', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();
    manager.registerAll();

    // Only registered once — if it were duplicated, dispose would show 2 entries
    manager.dispose();
    const globalDisposals = disposedTools.filter((n) => n === 'repolens-search');
    expect(globalDisposals.length).toBe(1);
  });

  it('syncRegistrations registers new tools on config change', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    // Simulate config change — should register new tool
    configTools = [makeTool('t-new', 'new-tool')];
    changeListeners.forEach((cb) => cb());

    expect(registeredTools.has('repolens-new-tool')).toBe(true);
    expect(registeredTools.has('repolens-search')).toBe(true);
    manager.dispose();
  });

  it('syncRegistrations unregisters removed tools', () => {
    configTools = [makeTool('t-1', 'my-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-my-tool')).toBe(true);

    // Remove tool from config
    configTools = [];
    changeListeners.forEach((cb) => cb());

    expect(registeredTools.has('repolens-my-tool')).toBe(false);
    expect(disposedTools).toContain('repolens-my-tool');
    manager.dispose();
  });

  it('dispose cleans up all registered tools including config tools', () => {
    configTools = [makeTool('t-1', 'my-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    manager.dispose();

    expect(disposedTools).toContain('repolens-search');
    expect(disposedTools).toContain('repolens-my-tool');
  });

  it('keeps global tool during syncRegistrations', () => {
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    // Trigger sync with empty config
    configTools = [];
    changeListeners.forEach((cb) => cb());

    // Global tool should still be registered
    expect(registeredTools.has('repolens-search')).toBe(true);
    expect(disposedTools).not.toContain('repolens-search');
    manager.dispose();
  });

  it('registered config tool invokes toolHandler.handle with correct id', async () => {
    configTools = [makeTool('t-1', 'my-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    const handler = registeredTools.get('repolens-my-tool');
    const mockOptions = { input: { query: 'test' } };
    const mockToken = { isCancellationRequested: false };

    await handler.invoke(mockOptions, mockToken);

    expect(toolHandler.handle).toHaveBeenCalledWith('t-1', mockOptions, mockToken);
    manager.dispose();
  });

  it('does not re-register unchanged tools on config change', () => {
    configTools = [makeTool('t-1', 'my-tool')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    // Trigger config change with same tools
    changeListeners.forEach((cb) => cb());

    // Should not have been disposed and re-registered
    expect(disposedTools).not.toContain('repolens-my-tool');
    manager.dispose();
  });

  it('handles tool replacement when name changes', () => {
    configTools = [makeTool('t-1', 'old-name')];
    const manager = new ToolManager(configManager, toolHandler, logger);
    manager.registerAll();

    expect(registeredTools.has('repolens-old-name')).toBe(true);

    // Simulate name change
    configTools = [makeTool('t-1', 'new-name')];
    changeListeners.forEach((cb) => cb());

    expect(registeredTools.has('repolens-old-name')).toBe(false);
    expect(registeredTools.has('repolens-new-name')).toBe(true);
    expect(disposedTools).toContain('repolens-old-name');
    manager.dispose();
  });
});

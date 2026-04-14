// Global search tool metadata.
// Registration is handled by ToolManager. This module defines the
// tool description used for Copilot discovery.

export const GLOBAL_SEARCH_TOOL = {
  name: 'yoink-search',
  displayName: 'Yoink Search',
  description:
    'Search across all configured repository knowledge bases. ' +
    'Use this to find code, documentation, patterns, or examples ' +
    'from any indexed GitHub repository.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string' as const,
        description: 'The search query to find relevant code or documentation',
      },
      tool: {
        type: 'string' as const,
        description:
          'Optional: use a configured Yoink tool name to search only its assigned repositories.',
      },
    },
    required: ['query'],
  },
};

export const LIST_TOOL = {
  name: 'yoink-list',
  displayName: 'Yoink List',
  description:
    'List all indexed data sources and configured tools in Yoink.',
};

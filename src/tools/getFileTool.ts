// Get File tool metadata.
// Registration is handled by ToolManager. This module defines the
// tool description used for Copilot discovery.

export const GET_FILE_TOOL = {
  name: 'repolens-get-file',
  displayName: 'RepoLens: Get File',
  description:
    'Fetch the full content of a file from an indexed GitHub repository. ' +
    'Use this when search results reference a file and you need more context ' +
    'than the returned chunk provides. Provide startLine and endLine to fetch ' +
    'a specific section of a large file.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description:
          "The indexed repository in 'owner/repo' format (e.g. 'vercel/next.js'). " +
          'Use the repository shown in search results.',
      },
      filePath: {
        type: 'string' as const,
        description: 'Path to the file within the repository, as shown in search results.',
      },
      startLine: {
        type: 'number' as const,
        description: 'Optional. First line to return (1-indexed). Use line numbers from search results.',
      },
      endLine: {
        type: 'number' as const,
        description: 'Optional. Last line to return (1-indexed). Use line numbers from search results.',
      },
    },
    required: ['repository', 'filePath'],
  },
};

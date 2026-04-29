export const GET_README_TOOL = {
  name: 'yoink-get-readme',
  displayName: 'Yoink: Get README',
  description:
    'Fetch the primary README for an indexed GitHub repository, or the README for a specific subtree. ' +
    'Use this when you want to understand what a repository or package does before searching more broadly. ' +
    'By default it resolves the repo root README. Pass path to look for a README in that exact directory only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repository: {
        type: 'string' as const,
        description: "Indexed repository in 'owner/repo' format (e.g. 'vercel/next.js').",
      },
      path: {
        type: 'string' as const,
        description: "Optional directory path to resolve a README from exactly that subtree root (e.g. 'packages/core').",
      },
    },
    required: ['repository'],
  },
};

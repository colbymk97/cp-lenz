// Repo type preset registry.
// Each type carries default include patterns, a chunking strategy, and a
// tool description template. Type is selected once in the wizard and drives
// defaults — users can override everything after selection.

import { ChunkingStrategy } from '../ingestion/chunker';

export type DataSourceType =
  | 'general'
  | 'documentation'
  | 'github-actions-library'
  | 'cicd-workflows'
  | 'openapi-specs';

export interface RepoTypePreset {
  id: DataSourceType;
  displayName: string;
  wizardDescription: string;
  includePatterns: string[];
  chunkingStrategy: ChunkingStrategy;
  toolDescriptionTemplate: (owner: string, repo: string) => string;
}

export const REPO_TYPE_PRESETS: Record<DataSourceType, RepoTypePreset> = {
  general: {
    id: 'general',
    displayName: 'General codebase',
    wizardDescription: 'Index all source files with default filters',
    includePatterns: [],
    chunkingStrategy: 'token-split',
    toolDescriptionTemplate: (o, r) => `Search the ${o}/${r} codebase`,
  },
  documentation: {
    id: 'documentation',
    displayName: 'Documentation / standards',
    wizardDescription: 'Markdown and docs files — chunks split on headings',
    includePatterns: ['**/*.md', 'docs/**', 'wiki/**'],
    chunkingStrategy: 'markdown-heading',
    toolDescriptionTemplate: (o, r) => `Search ${o}/${r} documentation and standards`,
  },
  'github-actions-library': {
    id: 'github-actions-library',
    displayName: 'GitHub Actions library',
    wizardDescription: 'action.yml / action.yaml files — one chunk per action',
    includePatterns: ['**/action.yml', '**/action.yaml', 'README.md'],
    chunkingStrategy: 'file-level',
    toolDescriptionTemplate: (o, r) =>
      `Look up GitHub Actions in ${o}/${r} — available actions, inputs, outputs, and usage`,
  },
  'cicd-workflows': {
    id: 'cicd-workflows',
    displayName: 'CI/CD workflows',
    wizardDescription: '.github/workflows/** — one chunk per workflow file',
    includePatterns: ['.github/workflows/**'],
    chunkingStrategy: 'file-level',
    toolDescriptionTemplate: (o, r) =>
      `Search CI/CD workflow definitions in ${o}/${r} — pipelines, jobs, and triggers`,
  },
  'openapi-specs': {
    id: 'openapi-specs',
    displayName: 'OpenAPI / specs',
    wizardDescription: 'YAML/JSON API spec files',
    includePatterns: ['**/*.yaml', '**/*.yml', '**/*.json', 'openapi/**', 'swagger/**'],
    chunkingStrategy: 'token-split',
    toolDescriptionTemplate: (o, r) =>
      `Search API specs in ${o}/${r} — endpoints, operations, and schemas`,
  },
};

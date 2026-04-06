import { describe, it, expect } from 'vitest';
import { FileFilter } from '../../../src/ingestion/fileFilter';

describe('FileFilter', () => {
  it('includes all files when no patterns specified', () => {
    const filter = new FileFilter([], []);
    expect(filter.matches('src/index.ts')).toBe(true);
    expect(filter.matches('README.md')).toBe(true);
  });

  it('filters by include patterns', () => {
    const filter = new FileFilter(['src/**/*.ts'], []);
    expect(filter.matches('src/index.ts')).toBe(true);
    expect(filter.matches('src/util/helper.ts')).toBe(true);
    expect(filter.matches('src/index.js')).toBe(false);
    expect(filter.matches('test/foo.ts')).toBe(false);
  });

  it('filters by exclude patterns', () => {
    const filter = new FileFilter([], ['**/node_modules/**', '**/dist/**']);
    expect(filter.matches('src/index.ts')).toBe(true);
    expect(filter.matches('node_modules/foo/index.js')).toBe(false);
    expect(filter.matches('dist/bundle.js')).toBe(false);
  });

  it('applies both include and exclude', () => {
    const filter = new FileFilter(['src/**/*.ts'], ['**/test/**']);
    expect(filter.matches('src/index.ts')).toBe(true);
    expect(filter.matches('src/test/foo.ts')).toBe(false);
    expect(filter.matches('lib/index.ts')).toBe(false);
  });

  it('supports multiple include patterns (OR logic)', () => {
    const filter = new FileFilter(['src/**/*.ts', 'docs/**/*.md'], []);
    expect(filter.matches('src/index.ts')).toBe(true);
    expect(filter.matches('docs/guide.md')).toBe(true);
    expect(filter.matches('src/index.js')).toBe(false);
  });

  it('excludes lock files', () => {
    const filter = new FileFilter([], ['**/package-lock.json', '**/yarn.lock']);
    expect(filter.matches('package-lock.json')).toBe(false);
    expect(filter.matches('yarn.lock')).toBe(false);
    expect(filter.matches('package.json')).toBe(true);
  });

  it('filterPaths returns only matching paths', () => {
    const filter = new FileFilter(['**/*.ts'], ['**/dist/**']);
    const paths = ['src/a.ts', 'src/b.js', 'dist/c.ts', 'lib/d.ts'];
    const result = filter.filterPaths(paths);
    expect(result).toEqual(['src/a.ts', 'lib/d.ts']);
  });

  it('handles dot files', () => {
    const filter = new FileFilter([], ['**/.git/**']);
    expect(filter.matches('.git/config')).toBe(false);
    expect(filter.matches('.gitignore')).toBe(true);
  });
});

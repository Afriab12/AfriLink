import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      // TypeScript's own compiler (via the existing `typecheck` script)
      // already catches undefined identifiers more reliably than ESLint
      // can — this also avoids false positives on Vitest's injected
      // globals (describe/it/expect from `test.globals: true`).
      'no-undef': 'off',
    },
  },
);

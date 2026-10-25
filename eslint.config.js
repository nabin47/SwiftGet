import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', 'site/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.webextensions } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Playwright fixtures use `async ({}, use) => …` by design.
    files: ['test/e2e/**'],
    rules: { 'no-empty-pattern': 'off' },
  },
);

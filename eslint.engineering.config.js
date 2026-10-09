import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// A scoped implementation gate for this engineering pass. The existing website
// lint and browser checks keep their own configurations. Do not use --fix for
// a repository-wide style rewrite; broaden this list only with reviewed work.
// Run: eslint --config eslint.engineering.config.js --max-warnings 0 .
export const engineeringTypescriptFiles = [
  'packages/agent-runtime/src/basket-model.ts',
  'packages/agent-runtime/src/coordinator.ts',
  'packages/agent-runtime/src/http-transport.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/merchant-adapter.ts',
  'packages/agent-runtime/src/session-record.ts',
  'packages/agent-runtime/src/session-scope.ts',
  'packages/agent-runtime/src/session-state.ts',
  'packages/agent-runtime/src/session-store-factory.ts',
  'packages/agent-runtime/src/session-view.ts',
  'packages/agent-runtime/src/shopping-model.ts',
  'packages/agent-runtime/src/sqlite-storage.ts',
  'packages/agent-runtime/src/sqlite-store.ts',
  'packages/agent-runtime/src/store.ts',
  'packages/agent-runtime/src/tool-loop.ts',
  'packages/agent-runtime/src/types.ts',
  'packages/agent-runtime/src/validation.ts',
  'packages/shopping-contracts/src/browser.ts',
  'packages/shopping-contracts/src/order-schema.ts',
  'packages/shopping-contracts/src/order.ts',
  'packages/shopping-contracts/src/quote-schema.ts',
  'packages/shopping-contracts/src/session-rules.ts',
  'packages/shopping-contracts/src/terms-schema.ts',
  'packages/shopping-contracts/src/views.ts',
  'packages/merchant-core/src/merchant-read.ts',
  'packages/merchant-core/src/orders.ts',
  'packages/ocp-cli/src/skill-installer.ts',
  'packages/ocp-cli/src/index.ts',
  'packages/ocp-cli/src/process-execution.ts',
  'packages/ocp-cli/src/update.ts',
  'scripts/check-engineering-inputs.ts',
  'apps/coffee-merchant-api/src/server.ts',
  'apps/shopping-agent-api/src/merchant-demo.ts',
  'apps/shopping-agent-api/src/server.ts',
  'apps/shopping-agent-api/src/model-settings.ts',
];

export const engineeringJavascriptFiles = [
  'shared/skill-installer-core.mjs',
  'packages/ocp-skill/bin/installer-core.mjs',
  'packages/ocp-skill/bin/ocp-skill.mjs',
];

const unusedOptions = {
  args: 'all',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'all',
  caughtErrorsIgnorePattern: '^_',
  ignoreRestSiblings: true,
};
const implementationRules = {
  'no-unsafe-optional-chaining': js.configs.recommended.rules['no-unsafe-optional-chaining'],
  'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
  'no-unreachable': js.configs.recommended.rules['no-unreachable'],
  'no-var': 'error',
};

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '.codex-tmp/**', '**/*.test.ts'] },
  {
    files: engineeringTypescriptFiles,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...implementationRules,
      // tsc handles identifiers and types. The TS-aware unused rule correctly
      // treats type-only imports, interfaces and parameter properties.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', unusedOptions],
    },
  },
  {
    files: engineeringJavascriptFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...implementationRules,
      'no-unused-vars': ['error', unusedOptions],
    },
  },
];

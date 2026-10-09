import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'public/contracts.js'] },
  {
    ...js.configs.recommended,
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-implicit-globals': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];

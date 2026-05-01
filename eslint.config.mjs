import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/target/**',
      '**/vendor/**',
      '**/.venv/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'shared/openapi/**',
      'backends/php/**',
      'backends/python/**',
      'backends/java/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);

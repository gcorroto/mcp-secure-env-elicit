import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**', 'tests/fixtures/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
    },
  },
  {
    // Plain JS files (this config file itself) are not part of a TS project,
    // so typed rules cannot run on them.
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.mjs', '**/*.js', '**/*.cjs'],
  },
  {
    files: ['src/application/**/*.ts', 'src/schemas/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['express'],
              message: 'Core modules must not depend on transport adapters or frameworks.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);

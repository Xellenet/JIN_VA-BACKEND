// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Underscore-prefixed names are an intentional "unused" convention
      // (e.g. destructuring a field off a DTO purely to exclude it from the
      // rest spread) — don't flag those as errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Jest's own `expect(mockObj.someMethod).toHaveBeenCalledWith(...)`
    // pattern is the standard way to assert on a jest.fn() mock, but
    // `@typescript-eslint/unbound-method` can't distinguish that from a
    // genuine unbound-`this` risk when the mock is typed as the real class
    // (`jest.Mocked<T>`/`useValue` pattern) — this is a well-known false
    // positive in Nest+Jest codebases (see typescript-eslint#1929).
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
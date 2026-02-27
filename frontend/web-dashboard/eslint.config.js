import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
<<<<<<< HEAD
import tseslint from 'typescript-eslint'
=======
>>>>>>> 3ade95e3b9400a2d0d2057a796e69cb67c65e250
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
<<<<<<< HEAD
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
=======
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
>>>>>>> 3ade95e3b9400a2d0d2057a796e69cb67c65e250
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
<<<<<<< HEAD
=======
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
>>>>>>> 3ade95e3b9400a2d0d2057a796e69cb67c65e250
    },
  },
])

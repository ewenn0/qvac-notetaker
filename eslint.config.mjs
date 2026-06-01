// ESLint 9 flat config.
//
// Covers the three TypeScript surfaces (main / preload / renderer). React-
// specific rules only apply to the renderer. Type-aware linting is left off
// by default so `npm run lint` stays fast and doesn't require a successful
// project build; flip `projectService` on if you want type-checked rules.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    // Anything generated or vendored is off-limits to the linter.
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '.vite/**',
      'stubs/**',
      '*.tsbuildinfo'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript node-side code: main process + preload.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // Plain JS/CJS build & diagnostic scripts. These are real CommonJS / Node
    // scripts — `require()` is correct here, and any leftover eslint-disable
    // directives shouldn't fail the run.
    files: ['scripts/**/*.{cjs,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node }
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Renderer: browser globals + React hook rules.
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  },
  {
    // Shared rules across all TS.
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // The SDK shape is asserted through `unknown` casts in a few places;
      // those are deliberate and documented, so don't fail the build on them.
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  // Disable stylistic rules that Prettier owns. Keep last.
  prettier
)

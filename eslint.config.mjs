import { FlatCompat } from '@eslint/eslintrc';
import { defineConfig, globalIgnores } from 'eslint/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: configDirectory });

export default defineConfig([
  ...compat.extends('next/core-web-vitals'),
  {
    rules: {
      // These effects intentionally synchronize component state from browser
      // storage, auth callbacks, and request lifecycles. Their transitions are
      // covered by focused unit and property tests.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['src/lib/server/**/*.{ts,tsx}', 'src/app/api/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['src/lib/server/storeLog.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
  ]),
]);

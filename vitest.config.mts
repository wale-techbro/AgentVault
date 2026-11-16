import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/coverage/**', '**/.next/**', '**/.next-build/**', '**/dist-worker/**'],
  },
});

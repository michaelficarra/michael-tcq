import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4 dropped `dist` from the default exclude list. The server's
    // tsc build emits compiled copies of every test file into dist/, so
    // without this we'd run each test twice.
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});

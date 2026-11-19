import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globalSetup: ['./src/database/global-setup.test-support.ts'], fileParallelism: false },
});

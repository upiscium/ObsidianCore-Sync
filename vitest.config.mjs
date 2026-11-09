import { defineConfig } from 'vitest/config';

// Retained source snapshots under dist/ and .integration/ are evidence, not
// additional test suites. Run only this checkout's explicitly selected tests.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'] },
});

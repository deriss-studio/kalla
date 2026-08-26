import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Worker threads share one process, so PGlite's WebAssembly is compiled
    // once for the run rather than once per worker — worth ~4s on the first
    // test of every file. Isolation is unaffected: each file still gets its
    // own module registry, and so its own database.
    pool: 'threads',
    // A cap, not a target: the scarce resource is concurrent Postgres
    // instances, not cores. A small runner still uses fewer. Above four,
    // wall time stops improving while the slowest test grows several-fold,
    // which is the number that has to stay clear of testTimeout.
    maxWorkers: 4,
    // Builds the migrated schema once, so no test file pays for initdb.
    globalSetup: ['./test/global-setup.ts'],
    // Opens one PGlite per test file and truncates between tests.
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

/**
 * At most four workers, and never more than the machine has.
 *
 * The scarce resource is concurrent Postgres instances rather than cores:
 * above four, wall time stops improving while the slowest test grows
 * several-fold, and it is the slowest test that has to stay clear of
 * testTimeout. So four is the ceiling.
 *
 * It has to be derived rather than pinned, because vitest reads maxWorkers as
 * an absolute: `config.maxWorkers ?? getDefaultThreadsCount(config)` never
 * consults the CPU count once the option is set. A literal 4 therefore means
 * four workers on a two-core runner, which is over-subscription rather than a
 * cap — the opposite of what the number is for.
 */
const workers = Math.max(1, Math.min(4, availableParallelism() - 1))

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Worker threads share one process, so PGlite's WebAssembly is compiled
    // once for the run rather than once per worker — worth ~4s on the first
    // test of every file. Isolation is unaffected: each file still gets its
    // own module registry, and so its own database.
    pool: 'threads',
    maxWorkers: workers,
    // Builds the migrated schema once, so no test file pays for initdb.
    globalSetup: ['./test/global-setup.ts'],
    // Opens one PGlite per test file and truncates between tests.
    setupFiles: ['./test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

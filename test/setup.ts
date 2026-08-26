/**
 * Per-file database lifecycle.
 *
 * vitest runs this once per test file, so these hooks bracket that file's
 * tests: every table is emptied between tests, and the file's PGlite instance
 * is closed when the file is done. See test/harness.ts for why the database
 * is per file rather than per test.
 */

import { afterAll, afterEach } from 'vitest'
import { closeDatabase, resetDatabase } from './harness.js'

afterEach(resetDatabase)
afterAll(closeDatabase)

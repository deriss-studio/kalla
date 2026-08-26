/**
 * Runs once per suite run, before any test file.
 *
 * Builds one migrated PGlite data directory and leaves it on disk for the test
 * files to restore from. That single cold `initdb` is the expensive part of
 * starting Postgres-in-WASM; every file after it starts in about a second.
 */

import { buildSchemaSnapshot, removeSchemaSnapshot } from './harness.js'

export async function setup(): Promise<void> {
  await buildSchemaSnapshot()
}

export async function teardown(): Promise<void> {
  await removeSchemaSnapshot()
}

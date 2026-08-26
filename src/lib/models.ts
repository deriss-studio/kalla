/**
 * Model access goes through here and nowhere else.
 *
 * Two rules, both of which exist so that a sovereignty claim can be evidenced
 * per cell rather than asserted on a trust page:
 *
 *   1. Never hardcode a provider anywhere else in the codebase.
 *   2. A provider that cannot report its processing region is not eligible.
 *      There is no "unknown" region — an unknown region is a failed call.
 */

export interface ModelCall {
  prompt: string
  system?: string
  maxTokens?: number
}

export interface ModelResponse {
  text: string
  modelId: string
  /** ISO region identifier. Recorded into provenance on every write. */
  modelRegion: string
  costCents?: number
}

export interface ModelAdapter {
  readonly id: string
  readonly region: string
  complete(call: ModelCall): Promise<ModelResponse>
}

export class RegionUnknownError extends Error {
  constructor(adapterId: string) {
    super(
      `adapter ${adapterId} does not report a processing region and is not eligible`,
    )
    this.name = 'RegionUnknownError'
  }
}

const registry = new Map<string, ModelAdapter>()

export function registerAdapter(adapter: ModelAdapter): void {
  if (!adapter.region) throw new RegionUnknownError(adapter.id)
  registry.set(adapter.id, adapter)
}

export function getAdapter(id: string): ModelAdapter {
  const adapter = registry.get(id)
  if (!adapter) throw new Error(`no adapter registered for ${id}`)
  return adapter
}

/**
 * Default policy: EU-processed inference. Override per column only with a
 * deliberate model_policy, never implicitly.
 */
export function selectAdapter(policy: string): ModelAdapter {
  const eu = [...registry.values()].filter((a) => a.region.startsWith('eu'))
  if (policy === 'default') {
    const first = eu[0]
    if (!first) throw new Error('no EU-region adapter registered')
    return first
  }
  return getAdapter(policy)
}

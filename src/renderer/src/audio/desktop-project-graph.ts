import type { ProjectGraphReadResult } from '../../../shared/types'
import {
  GRAPH_DOCUMENT_FORMAT,
  parseGraphDocument,
  type ParsedGraphDocument
} from '../../../shared/graph-document'

export class DesktopProjectGraphLoadError extends Error {
  constructor(
    readonly code: Exclude<ProjectGraphReadResult, { ok: true }>['code'] | 'invalid-renderer-projection',
    message: string
  ) {
    super(message)
    this.name = 'DesktopProjectGraphLoadError'
  }
}

export type DesktopProjectGraphLoadResult =
  | { accepted: false }
  | { accepted: true; graphDocument: ParsedGraphDocument | null }

/**
 * Consume exactly one main-process read of the hash-bound graph member. The
 * caller's song epoch is checked immediately after IPC, before a failure or
 * document can mutate the newly selected song. Opaque format-1 data remains
 * on the parsed JS document; only the later native projection strips it.
 */
export async function loadDesktopProjectGraph(
  read: () => Promise<ProjectGraphReadResult>,
  isCurrent: () => boolean
): Promise<DesktopProjectGraphLoadResult> {
  const result = await read()
  if (!isCurrent()) return { accepted: false }
  if (!result.ok) throw new DesktopProjectGraphLoadError(result.code, result.error)
  if (result.graph === null) return { accepted: true, graphDocument: null }
  try {
    const parsed = parseGraphDocument(result.graph.text)
    if (parsed.kind !== 'known' || parsed.format !== GRAPH_DOCUMENT_FORMAT) {
      throw new DesktopProjectGraphLoadError(
        'invalid-renderer-projection',
        'The project DSP graph needs a newer SingZ runtime.'
      )
    }
    return { accepted: true, graphDocument: parsed }
  } catch (error) {
    if (error instanceof DesktopProjectGraphLoadError) throw error
    throw new DesktopProjectGraphLoadError(
      'invalid-renderer-projection',
      `The verified project DSP graph cannot be projected: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

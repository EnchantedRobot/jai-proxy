import type { Bucket, EditorGroup } from '@/lib/tags/tags-editor'

/** Where a chip currently lives (its move source). */
export type MoveFrom = EditorGroup | Bucket

/**
 * Where a chip is moving to. A group is named by id (not the object) so the
 * page can resolve it against the current state when the move is applied, rather
 * than closing over a possibly-stale group reference from render time.
 */
export type MoveDest = { groupId: string } | 'unassigned' | 'removed' | 'new'

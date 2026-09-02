/**
 * `LoroDoc.commit({ origin })` values this package writes or reads.
 *
 * Every member has behavioural meaning to either the UndoManager (via
 * `addExcludeOriginPrefix` in `undo-plugin.ts`) or the sync plugin's own event
 * dispatch, so they are named here rather than repeated as string literals.
 */
export const LoroOrigins = {
  /** Bootstrap writes: the first population of an empty document. Excluded
   *  from the undo stack by prefix match, see `undo-plugin.ts`. */
  sysInit: "sys:init",
  /** Default origin for a ProseMirror → Loro write-back. Tracked by the
   *  UndoManager, so user edits land on the undo stack. */
  userEdit: "loroSyncPlugin",
  /** Origin Loro's own `UndoManager.undo()`/`redo()` stamp onto the commits
   *  they produce. Read-only from this package's perspective: never set it,
   *  only compare against it to recognise an undo/redo-driven event. */
  undo: "undo",
  /** The `sys:` namespace prefix every system-authored origin lives under.
   *  For consumers that must match the whole namespace rather than one
   *  member, so a future `sys:*` origin is excluded from undo without a code
   *  change. */
  sysNamespace: "sys:",
} as const;

/**
 * `Transaction.setMeta(key, value)` keys carrying sync-protocol signals on
 * the ProseMirror side, as opposed to commit origins on the Loro side.
 */
export const LoroTxMeta = {
  /**
   * Marks a transaction as an application-driven time-travel render -- a
   * checkout or restore replacing the document -- rather than a local edit.
   * The sync plugin skips the write-back for it -- a detached document is
   * read-only, and a write-back that changed anything would throw -- and the
   * undo plugin skips cursor conversion against the checked-out state.
   */
  timeTravelSync: "time-travel-sync",
} as const;

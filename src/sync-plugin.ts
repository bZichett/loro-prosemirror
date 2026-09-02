import type { Cursor, LoroEventBatch } from "loro-crdt";
import { Fragment, type Node as PmNode, Slice } from "prosemirror-model";
import {
  type EditorState,
  Plugin,
  type Selection,
  type StateField,
  TextSelection,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  convertPmSelectionToCursors,
  resolveCursorPosition,
} from "./cursor/common";
import {
  clearChangedNodes,
  getRootContainer,
  type LoroDocType,
  type LoroNodeMapping,
  safeSetSelection,
} from "./lib";
import {
  loroSyncPluginKey,
  type LoroSyncPluginProps,
  type LoroSyncPluginState,
} from "./sync-plugin-key";
import { resolveContainerStrategy } from "./container-strategy";
import { buildMappingFromExistingDoc } from "./build-mapping";
import { tryFastTextSync } from "./incremental-sync";
import { LoroOrigins, LoroTxMeta } from "./origins";
import { configLoroTextStyle } from "./text-style";
import { loroUndoPluginKey } from "./undo-plugin-key";

type PluginTransactionType =
  | {
      type: "doc-changed";
    }
  | {
      type: "non-local-updates";
    }
  | {
      type: "update-state";
      state: Partial<LoroSyncPluginState>;
    }
  | {
      type: "init-error";
      error: string;
    };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether the editor holds only the document ProseMirror creates for a
 * stateless editor -- `topNodeType.createAndFill()` -- as opposed to content
 * it was given. Compared structurally, so it is exact rather than a size
 * heuristic.
 */
function isEmptyScaffold(state: EditorState): boolean {
  const scaffold = state.schema.topNodeType.createAndFill();
  return scaffold != null && state.doc.eq(scaffold);
}

/**
 * Whether a transaction originated outside the sync layer and so needs a
 * write-back. Remote updates, state init, and a time-travel render marked
 * `LoroTxMeta.timeTravelSync` are all Loro-managed: writing them back would
 * echo Loro to itself, or mutate a detached, read-only document and throw.
 */
function isNonLoroManaged(tr: Transaction): boolean {
  if (tr.getMeta(LoroTxMeta.timeTravelSync)) return false;
  const meta = tr.getMeta(loroSyncPluginKey) as PluginTransactionType | null;
  return meta?.type !== "non-local-updates" && meta?.type !== "update-state";
}

export const LoroSyncPlugin = (props: LoroSyncPluginProps): Plugin => {
  return new Plugin({
    key: loroSyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = loroSyncPluginKey.getState(state);
        if (syncState?.snapshot != null) return false;
        // Read-only during the collaboration cold start: a keystroke typed
        // before the first import lives only in the editor and is wiped by
        // that import's rebuild.
        if (syncState?.collaboration && !syncState.loroReady) return false;
        return true;
      },
    },
    state: {
      init: (_config, editorState): LoroSyncPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        // Spread rather than copying fields across: the state extends the
        // props, so mirroring them by name silently drops every option added
        // later -- which is exactly how `rootKey` first went missing here.
        return {
          ...props,
          mapping: props.mapping ?? new Map(),
          changedBy: "local",
          strategy: resolveContainerStrategy(
            props.container,
            editorState.doc.type.name,
          ),
        };
      },
      apply: (tr, state, oldEditorState, newEditorState) => {
        const meta = tr.getMeta(
          loroSyncPluginKey,
        ) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        if (meta?.type === "non-local-updates") {
          state.changedBy = "import";
          // The first import has arrived; Loro is populated and writes are safe.
          if (state.collaboration && !state.loroReady) {
            state.loroReady = true;
          }
        } else {
          state.changedBy = "local";
        }
        switch (meta?.type) {
          case "doc-changed":
            if (state.initError) {
              // Sync is disabled; the editor keeps working on its own document.
              break;
            }
            if (
              !undoState?.isUndoing.current &&
              (!state.collaboration || state.loroReady)
            ) {
              try {
                state.strategy.write(state, state.mapping, newEditorState);
              } catch (err) {
                // A write-back that throws is a runtime failure, not a document
                // state, and it would recur on every keystroke. Disable sync
                // rather than let the editor freeze.
                console.error(
                  "[LoroSync] write-back failed; disabling sync:",
                  err,
                );
                return {
                  ...state,
                  initError: `sync-disabled: ${errorMessage(err)}`,
                };
              }
            }
            // Save Loro cursors while PM and Loro are in sync.
            // Remote events will reuse these instead of converting stale PM
            // positions against the already-imported Loro text.
            try {
              const { anchor, focus } = convertPmSelectionToCursors(
                newEditorState.doc,
                newEditorState.selection,
                state,
              );
              state.savedAnchor = anchor;
              state.savedFocus = focus;
            } catch {
              // Cursor conversion failing is not worth disabling sync for; a
              // stale saved cursor only affects where the caret lands after
              // the next remote update.
            }
            break;
          case "update-state":
            state = { ...state, ...meta.state };
            // No explicit timestamp: Loro's `Change.timestamp` is in seconds,
            // so passing `Date.now()` stamped a far-future value. Loro fills
            // in its own, as every other commit in this package lets it.
            state.doc.commit({
              origin: LoroOrigins.sysInit,
              message: LoroOrigins.sysInit,
            });
            break;
          case "init-error":
            state = { ...state, initError: meta.error };
            break;
          default:
            break;
        }
        return state;
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, _oldEditorState, newEditorState) => {
      if (transactions.some((tr) => tr.docChanged && isNonLoroManaged(tr))) {
        return newEditorState.tr.setMeta(loroSyncPluginKey, {
          type: "doc-changed",
        });
      }
      return null;
    },
    view: (view: EditorView) => {
      const timeoutId = setTimeout(() => {
        try {
          init(view);
        } catch (err) {
          // An exception here would otherwise be lost in the timer callback,
          // leaving an editor that looks fine and silently never syncs.
          console.error("[LoroSync] initialization failed:", err);
          if (!view.isDestroyed) {
            view.dispatch(
              view.state.tr.setMeta(loroSyncPluginKey, {
                type: "init-error",
                error: errorMessage(err),
              }),
            );
          }
        }
      }, 0);
      return {
        update: (view: EditorView, prevState: EditorState) => {
          // Save Loro cursors on selection-only changes (Home/End/click) so
          // savedAnchor is available before the first local "doc-changed" fires.
          // Doc changes are handled in apply (doc-changed saves cursors there).
          // When only the selection moves the doc hasn't changed, so PM ↔ Loro
          // are still in sync and the cursor conversion is correct.
          if (
            view.state.doc === prevState.doc &&
            !view.state.selection.eq(prevState.selection)
          ) {
            const state = loroSyncPluginKey.getState(
              view.state,
            ) as LoroSyncPluginState;
            if (!state || state.initError) return;
            try {
              const { anchor, focus } = convertPmSelectionToCursors(
                view.state.doc,
                view.state.selection,
                state,
              );
              state.savedAnchor = anchor;
              state.savedFocus = focus;
            } catch {
              // See the matching catch in apply(): a stale cursor is tolerable.
            }
          }
        },
        destroy: () => {
          clearTimeout(timeoutId);
        },
      };
    },
  });
};

// This is called when the plugin's state is associated with an editor view
function init(view: EditorView) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;

  let docSubscription = state.docSubscription;

  docSubscription?.();

  // An exception inside a Loro subscription callback propagates into Loro's
  // event dispatch, where it can leave the document mid-update. Contain it.
  const onEvent = (event: LoroEventBatch) => {
    try {
      updateNodeOnLoroEvent(view, event);
    } catch (err) {
      console.error("[LoroSync] failed to apply a Loro event:", err);
    }
  };

  if (state.containerId) {
    docSubscription = state
      .doc!.getContainerById(state.containerId)!
      .subscribe(onEvent);
  } else {
    docSubscription = state.doc.subscribe(onEvent);
  }

  const { strategy } = state;
  const mapping: LoroNodeMapping = new Map();
  if (strategy.isUnpopulated(state)) {
    const editorHasContent = !isEmptyScaffold(view.state);
    let tr = view.state.tr;
    if (state.collaboration && editorHasContent) {
      // A server owns the first materialisation and the editor's content is a
      // preview of it. Writing it back would create local containers that
      // conflict with the server's. Wait, read-only, for the first import.
    } else if (
      state.collaboration ||
      (state.seedFromEditor && editorHasContent)
    ) {
      // Seed Loro from the editor under sysInit. In collaboration this gives
      // the undo stack a baseline for the scaffold before the first import;
      // with seedFromEditor it recovers content Loro never received. Neither
      // lands on the undo stack.
      strategy.write(state, mapping, view.state, LoroOrigins.sysInit);
    } else {
      // Loro is the source of truth: an unpopulated root is an empty document.
      tr = tr.delete(0, view.state.doc.content.size);
    }
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: {
        mapping,
        docSubscription,
        snapshot: null,
        loroReady: !state.collaboration || !editorHasContent,
      },
    });
    view.dispatch(tr);
  } else if (
    state.fastInit &&
    strategy.fastPaths &&
    buildMappingFromExistingDoc(
      getRootContainer(state.doc, state.containerId, state.rootKey),
      view.state.doc,
      mapping,
    )
  ) {
    // The editor's document already matches Loro, so the mapping was built by
    // walking both without replacing the document, and plugin decorations
    // survive. A transaction with no steps keeps the same document instance.
    const tr = view.state.tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null, loroReady: true },
    });
    view.dispatch(tr);
  } else {
    // A failed fast-init walk may have partially filled the mapping.
    mapping.clear();
    const node = strategy.read(state, mapping, view.state.schema, {
      onSchemaViolation: state.onSchemaViolation,
    });
    const tr = view.state.tr;
    if (node != null) {
      tr.replace(
        0,
        view.state.doc.content.size,
        new Slice(Fragment.from(node), 0, 0),
      );
    } else {
      // Feeding null to Fragment.from yields an empty fragment and would blank
      // the editor. A root with no valid representation at this point is a
      // transient state during bootstrap; keep what the editor holds.
      console.warn(
        "[LoroSync] init: document has no valid representation yet; keeping the editor's content",
      );
    }
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null, loroReady: true },
    });
    view.dispatch(tr);
  }
}

function updateNodeOnLoroEvent(view: EditorView, event: LoroEventBatch) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;
  state.changedBy = event.by;
  if (event.by === "local" && event.origin !== LoroOrigins.undo) {
    return;
  }
  if (event.by === "checkout" && state.externalCheckout) {
    // The application owns checkout rendering (see `externalCheckout`).
    return;
  }

  if (state.fastTextSync) {
    try {
      if (tryFastTextSync(view, event, state)) {
        return;
      }
    } catch (err) {
      // The fast path verifies itself and bails cleanly on any check it can
      // anticipate; an exception is something it did not. The full rebuild
      // below reads Loro as the source of truth, so it recovers from any
      // state the partial attempt left behind.
      console.warn(
        "[LoroSync] fast text sync failed, falling back to full rebuild:",
        err,
      );
      state.mapping.clear();
    }
  }

  const mapping = state.mapping;
  clearChangedNodes(state.doc as LoroDocType, event, mapping);
  let node = state.strategy.read(state, mapping, view.state.schema, {
    onSchemaViolation: state.onSchemaViolation,
  });

  // The reader returns null both for a root with no blocks and for content
  // the schema rejects, and the two need opposite handling. A blockless root
  // is a real state -- undoing back to the pre-typing baseline reaches it --
  // and must be rendered as an empty document, or the undo appears to do
  // nothing while Loro has moved. A rejected document must not be replaced
  // with a blank one. The strategy tells them apart.
  if (node == null && state.strategy.isEmpty(state)) {
    node = view.state.schema.topNodeType.createAndFill();
  }
  if (node == null) {
    console.warn(
      "[LoroSync] skipping update: the document has no valid representation in the schema",
    );
    return;
  }
  // Use saved cursors (captured when PM ↔ Loro were last in sync) rather than
  // converting the current PM selection.  After doc.import() the Loro text
  // already contains the remote characters but the PM document hasn't been
  // rebuilt yet, so absolutePositionToCursor would resolve PM offsets against
  // the wrong text length, placing the cursor at the wrong Fugue-tree node.
  // For undo events, the undo plugin's onPop (which fires after this
  // function) overwrites this cursor with the correct undo stack position.
  const anchor = state.savedAnchor;
  const focus = state.savedFocus;

  let tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );

  tr.setMeta(loroSyncPluginKey, {
    type: "non-local-updates",
  });

  // Restore cursor in the same transaction to prevent keystrokes from
  // landing at the wrong position between dispatch and a deferred fix.
  // `state.doc` and `mapping` are already updated by clearChangedNodes +
  // createNodeFromLoroObj above, so cursorToAbsolutePosition works here.
  if (anchor != null) {
    const sel = resolveLoroSelection(tr.doc, state, anchor, focus);
    if (sel) {
      tr = tr.setSelection(sel);
    }
  }

  view.dispatch(tr);
}

/**
 * Resolve Loro stable cursors to a ProseMirror TextSelection against a
 * given document. Clamps positions to valid range rather than rejecting,
 * so the cursor lands as close to the intended position as possible
 * instead of silently resetting to the document start.
 */
function resolveLoroSelection(
  pmDoc: PmNode,
  state: LoroSyncPluginState,
  anchor: Cursor,
  focus?: Cursor,
): Selection | null {
  const anchorPos = resolveCursorPosition(anchor, state)[0];
  if (anchorPos == null) return null;

  const focusPos = focus ? resolveCursorPosition(focus, state)[0] : undefined;

  const docSize = pmDoc.content.size;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, docSize));

  try {
    return TextSelection.between(
      pmDoc.resolve(clamp(anchorPos)),
      pmDoc.resolve(clamp(focusPos ?? anchorPos)),
    );
  } catch (e) {
    console.warn("resolveLoroSelection: failed to resolve cursor position", e);
    return null;
  }
}

/**
 * Update ProseMirror selection based on the given Loro cursors.
 */
export function syncCursorsToPmSelection(
  view: EditorView,
  anchor: Cursor,
  focus?: Cursor,
) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (!state) {
    return;
  }

  const anchorPos = resolveCursorPosition(anchor, state)[0];
  const focusPos = focus && resolveCursorPosition(focus, state)[0];
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos);
}

import type { Cursor, LoroEventBatch, LoroMap } from "loro-crdt";
import { Fragment, type Node as PmNode, Slice } from "prosemirror-model";
import {
  type EditorState,
  Plugin,
  type StateField,
  TextSelection,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "./cursor/common";
import {
  clearChangedNodes,
  createNodeFromLoroObj,
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  safeSetSelection,
  updateLoroToPmState,
} from "./lib";
import {
  loroSyncPluginKey,
  type LoroSyncPluginProps,
  type LoroSyncPluginState,
} from "./sync-plugin-key";
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
    };

export const LoroSyncPlugin = (props: LoroSyncPluginProps): Plugin => {
  return new Plugin({
    key: loroSyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = loroSyncPluginKey.getState(state);
        return syncState?.snapshot == null;
      },
    },
    state: {
      init: (_config, editorState): LoroSyncPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        return {
          doc: props.doc,
          mapping: props.mapping ?? new Map(),
          changedBy: "local",
          containerId: props.containerId,
        };
      },
      apply: (tr, state, oldEditorState, newEditorState) => {
        const meta = tr.getMeta(
          loroSyncPluginKey,
        ) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        if (meta?.type === "non-local-updates") {
          state.changedBy = "import";
        } else {
          state.changedBy = "local";
        }
        switch (meta?.type) {
          case "doc-changed":
            if (!undoState?.isUndoing.current) {
              updateLoroToPmState(
                state.doc as LoroDocType,
                state.mapping,
                newEditorState,
                props.containerId,
              );
            }
            // Save Loro cursors while PM and Loro are in sync.
            // Remote events will reuse these instead of converting stale PM
            // positions against the already-imported Loro text.
            {
              const { anchor, focus } = convertPmSelectionToCursors(
                newEditorState.doc,
                newEditorState.selection,
                state,
              );
              state.savedAnchor = anchor;
              state.savedFocus = focus;
            }
            break;
          case "update-state":
            state = { ...state, ...meta.state };
            state.doc.commit({
              origin: "sys:init",
              timestamp: Date.now(),
            });
            break;
          default:
            break;
        }
        return state;
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, _oldEditorState, newEditorState) => {
      if (
        transactions.some(
          (tr) =>
            tr.docChanged &&
            tr.getMeta(loroSyncPluginKey)?.type !== "non-local-updates" &&
            tr.getMeta(loroSyncPluginKey)?.type !== "update-state",
        )
      ) {
        return newEditorState.tr.setMeta(loroSyncPluginKey, {
          type: "doc-changed",
        });
      }
      return null;
    },
    view: (view: EditorView) => {
      const timeoutId = setTimeout(() => init(view), 0);
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
            if (!state) return;
            const { anchor, focus } = convertPmSelectionToCursors(
              view.state.doc,
              view.state.selection,
              state,
            );
            state.savedAnchor = anchor;
            state.savedFocus = focus;
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

  if (state.containerId) {
    docSubscription = state
      .doc!.getContainerById(state.containerId)!
      .subscribe((event) => {
        updateNodeOnLoroEvent(view, event);
      });
  } else {
    docSubscription = state.doc.subscribe((event) =>
      updateNodeOnLoroEvent(view, event),
    );
  }

  const innerDoc = state.containerId
    ? (state.doc.getContainerById(
        state.containerId,
      ) as LoroMap<LoroNodeContainerType>)
    : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY);

  const mapping: LoroNodeMapping = new Map();
  if (innerDoc.size === 0) {
    // Empty doc
    const tr = view.state.tr.delete(0, view.state.doc.content.size);
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  } else {
    const schema = view.state.schema;
    // Create node from loro object
    const node = createNodeFromLoroObj(
      schema,
      innerDoc as LoroMap<LoroNodeContainerType>,
      mapping,
    );
    const tr = view.state.tr.replace(
      0,
      view.state.doc.content.size,
      new Slice(Fragment.from(node), 0, 0),
    );
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
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
  if (event.by === "local" && event.origin !== "undo") {
    return;
  }

  const mapping = state.mapping;
  clearChangedNodes(state.doc as LoroDocType, event, mapping);
  const node = createNodeFromLoroObj(
    view.state.schema,
    state.containerId
      ? (state.doc.getContainerById(
          state.containerId,
        ) as LoroMap<LoroNodeContainerType>)
      : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY),
    mapping,
  );
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
    const sel = resolveLoroSelection(tr.doc, state.doc, mapping, anchor, focus);
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
  loroDoc: LoroDocType | LoroMap,
  mapping: LoroNodeMapping,
  anchor: Cursor,
  focus?: Cursor,
): TextSelection | null {
  const anchorPos = cursorToAbsolutePosition(anchor, loroDoc, mapping)[0];
  if (anchorPos == null) return null;

  const focusPos = focus
    ? cursorToAbsolutePosition(focus, loroDoc, mapping)[0]
    : undefined;

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

  const { doc, mapping } = state;
  const anchorPos = cursorToAbsolutePosition(anchor, doc, mapping)[0];
  const focusPos = focus && cursorToAbsolutePosition(focus, doc, mapping)[0];
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos);
}

/**
 * @vitest-environment jsdom
 *
 * Regression test for the undo plugin cursor race condition.
 *
 * When Ctrl+Z fires, two cursor restoration paths execute:
 *
 * 1. INLINE (immediate): updateNodeOnLoroEvent rebuilds PM and restores
 *    cursor from savedAnchor — the cursor from the user's last selection,
 *    NOT from the undo stack.
 *
 * 2. DEFERRED (setTimeout): The undo plugin's onPop callback schedules
 *    syncCursorsToPmSelection with the undo stack cursor — correct target,
 *    but dispatched as a separate transaction after a microtask gap.
 *
 * Between step 1 and step 2, the cursor is at the wrong position. If a
 * remote doc.import() lands in that gap, the deferred cursor correction
 * fires against a document that has changed, and the intermediate wrong
 * cursor position can cause keystrokes to land at the wrong place.
 *
 * The fix: pass undo cursors inline via plugin state (undoCursors) so
 * updateNodeOnLoroEvent uses them instead of savedAnchor when
 * event.origin === "undo". No setTimeout needed.
 */

import { afterEach, describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { LoroUndoPlugin, undo } from "../src/undo-plugin";
import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import { loroUndoPluginKey } from "../src/undo-plugin-key";

import { schema } from "./schema";
import { createEditorState } from "./utils";

function sync(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update" }));
}

function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function seedLoro(doc: LoroDocType, text: string) {
  const pm = createEditorState(schema, {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  });
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(doc, mapping, pm);
  doc.commit();
}

function createPeer(seedText: string) {
  const doc: LoroDocType = new LoroDoc();
  seedLoro(doc, seedText);
  const state = EditorState.create({
    schema,
    plugins: [
      LoroSyncPlugin({ doc }),
      LoroUndoPlugin({ doc }),
    ],
  });
  const view = new EditorView(document.createElement("div"), { state });
  return { doc, view };
}

function createSyncedPeer(sourceDoc: LoroDoc) {
  const doc: LoroDocType = new LoroDoc();
  sync(sourceDoc, doc);
  const state = EditorState.create({
    schema,
    plugins: [
      LoroSyncPlugin({ doc }),
      LoroUndoPlugin({ doc }),
    ],
  });
  const view = new EditorView(document.createElement("div"), { state });
  return { doc, view };
}

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) {
    if (!v.isDestroyed) v.destroy();
  }
  views.length = 0;
});

describe("Undo plugin cursor race condition", () => {
  test("undo cursor is correct immediately, not just after setTimeout", async () => {
    // Setup: single peer with "hello world"
    const peer = createPeer("hello world");
    views.push(peer.view);
    await flushTimer(); // let init() fire

    expect(peer.view.state.doc.textContent).toBe("hello world");

    // Place cursor at beginning (pos 1), then type "ABC"
    {
      const tr = peer.view.state.tr.setSelection(
        TextSelection.create(peer.view.state.doc, 1),
      );
      peer.view.dispatch(tr);
    }
    {
      const tr = peer.view.state.tr.insertText("ABC", 1);
      peer.view.dispatch(tr);
    }
    peer.doc.commit(); // ensure undo stack has the operation

    expect(peer.view.state.doc.textContent).toBe("ABChello world");
    expect(peer.view.state.selection.anchor).toBe(4); // after "ABC"

    // Move cursor to end — this updates savedAnchor to end position
    {
      const endPos = peer.view.state.doc.content.size - 1;
      const tr = peer.view.state.tr.setSelection(
        TextSelection.create(peer.view.state.doc, endPos),
      );
      peer.view.dispatch(tr);
    }
    // savedAnchor is now the Loro cursor for the END of "ABChello world"

    const undoState = loroUndoPluginKey.getState(peer.view.state);
    expect(undoState?.undoManager.canUndo()).toBe(true);

    // --- UNDO ---
    // Fires: onPop (setTimeout queued) → updateNodeOnLoroEvent (inline)
    // updateNodeOnLoroEvent uses savedAnchor (end position), not undo cursor
    undo(peer.view.state, peer.view.dispatch);

    expect(peer.view.state.doc.textContent).toBe("hello world");

    // THE KEY ASSERTION:
    // Cursor SHOULD be at 1 (where it was before typing "ABC")
    // BUG: cursor is at ~12 (savedAnchor resolved to end of "hello world")
    const cursorBeforeFlush = peer.view.state.selection.anchor;

    // After flushing, setTimeout fires → corrects cursor via separate transaction
    await flushTimer();
    const cursorAfterFlush = peer.view.state.selection.anchor;

    // With the fix (inline undo cursors): both are 1
    // Without the fix: cursorBeforeFlush is wrong (~12), only cursorAfterFlush is 1
    expect(cursorBeforeFlush).toBe(1);
    expect(cursorAfterFlush).toBe(1);
  });

  test("two peers: undo + remote import in the setTimeout gap", async () => {
    // Setup: two synced peers with "hello world"
    const peer1 = createPeer("hello world");
    const peer2 = createSyncedPeer(peer1.doc);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("hello world");

    // Peer2: type "ABC" at beginning
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 1),
      );
      peer2.view.dispatch(tr);
    }
    {
      const tr = peer2.view.state.tr.insertText("ABC", 1);
      peer2.view.dispatch(tr);
    }
    peer2.doc.commit();
    expect(peer2.view.state.doc.textContent).toBe("ABChello world");

    // Peer2: move cursor to end (updates savedAnchor)
    {
      const endPos = peer2.view.state.doc.content.size - 1;
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, endPos),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: type "XYZ" at end of "hello world"
    {
      const endPos = peer1.view.state.doc.content.size - 1;
      const tr = peer1.view.state.tr.insertText("XYZ", endPos);
      peer1.view.dispatch(tr);
    }
    peer1.doc.commit();

    // --- UNDO on peer2 ---
    // onPop: setTimeout queued with undo cursor (pos 1)
    // updateNodeOnLoroEvent: uses savedAnchor (end of "ABChello world")
    undo(peer2.view.state, peer2.view.dispatch);

    // Cursor should already be at undo position
    const cursorAfterUndo = peer2.view.state.selection.anchor;

    // While setTimeout is still pending, sync peer1's "XYZ" into peer2
    // This fires another updateNodeOnLoroEvent with savedAnchor (still wrong)
    sync(peer1.doc, peer2.doc);

    // Cursor should still be at undo position, adjusted for remote insert
    const cursorAfterSync = peer2.view.state.selection.anchor;

    // Flush all pending setTimeouts
    await flushTimer();
    const cursorAfterFlush = peer2.view.state.selection.anchor;

    // Verify merged text: "hello worldXYZ" (ABC undone, XYZ from peer1)
    expect(peer2.view.state.doc.textContent).toBe("hello worldXYZ");

    // Undo cursor was at position 1 (before "h" in "hello world")
    // XYZ is at the end, so position 1 is unaffected by the remote insert
    // All three checkpoints should show cursor at 1
    //
    // BUG: cursorAfterUndo and cursorAfterSync are wrong (savedAnchor position)
    // Only cursorAfterFlush might be correct (setTimeout fires)
    expect(cursorAfterUndo).toBe(1);
    expect(cursorAfterSync).toBe(1);
    expect(cursorAfterFlush).toBe(1);
  });
});

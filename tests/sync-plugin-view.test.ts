/**
 * @vitest-environment jsdom
 *
 * Plugin-level regression test for the cursor race condition.
 *
 * Creates actual EditorView instances with LoroSyncPlugin to exercise
 * the full plugin lifecycle: init → local edit → remote import →
 * updateNodeOnLoroEvent → cursor restoration.
 *
 * The key assertion: after a remote import inserts text BEFORE the
 * cursor, the cursor position must shift right by the number of
 * inserted characters. Without the savedAnchor fix, the cursor stays
 * at its stale PM position (wrong).
 */

import { afterEach, describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

function sync(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update" }));
}

/** Flush the setTimeout(0) used by the plugin's view() to call init(). */
function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Pre-populate a LoroDoc with a paragraph containing the given text. */
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

/** Create a LoroDoc seeded with text, then create an EditorView with LoroSyncPlugin. */
function createPeer(seedText: string) {
  const doc: LoroDocType = new LoroDoc();
  seedLoro(doc, seedText);
  const state = EditorState.create({
    schema,
    plugins: [LoroSyncPlugin({ doc })],
  });
  const view = new EditorView(document.createElement("div"), { state });
  return { doc, view };
}

/** Create a peer that syncs from an existing doc (no independent seed). */
function createSyncedPeer(sourceDoc: LoroDoc) {
  const doc: LoroDocType = new LoroDoc();
  sync(sourceDoc, doc);
  const state = EditorState.create({
    schema,
    plugins: [LoroSyncPlugin({ doc })],
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

describe("LoroSyncPlugin view-level integration", () => {
  test("cursor shifts right when remote inserts text before cursor", async () => {
    // --- Setup: peer1 has "seed text", peer2 syncs from it ---
    const peer1 = createPeer("seed text");
    const peer2 = createSyncedPeer(peer1.doc);
    views.push(peer1.view, peer2.view);

    // Let init() fire — builds PM from Loro
    await flushTimer();

    // Verify both have "seed text"
    expect(peer1.view.state.doc.textContent).toBe("seed text");
    expect(peer2.view.state.doc.textContent).toBe("seed text");

    // --- Peer2: place cursor at end of text, then type "X" ---
    // This triggers doc-changed which saves Loro cursors (savedAnchor)
    {
      const endPos = peer2.view.state.doc.content.size - 1; // before paragraph close
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, endPos),
      );
      peer2.view.dispatch(tr);
    }
    {
      const tr = peer2.view.state.tr.insertText(
        "X",
        peer2.view.state.selection.anchor,
      );
      peer2.view.dispatch(tr);
    }

    // appendTransaction fires doc-changed → updateLoroToPmState
    expect(peer2.view.state.doc.textContent).toBe("seed textX");
    const posAfterX = peer2.view.state.selection.anchor;

    // --- Peer1: insert "ALPHA" at beginning ---
    {
      const tr = peer1.view.state.tr.insertText("ALPHA", 1);
      peer1.view.dispatch(tr);
    }

    // --- Critical: import peer1's changes into peer2's Loro ---
    // This triggers updateNodeOnLoroEvent via the Loro subscription.
    // With fix: savedAnchor auto-adjusts → cursor shifts right by 5
    // Without fix: stale PM offset → cursor stays at wrong position
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Verify merged text
    const mergedText = peer2.view.state.doc.textContent;
    expect(mergedText).toContain("ALPHA");
    expect(mergedText).toContain("seed text");
    expect(mergedText).toContain("X");

    // --- THE KEY ASSERTION ---
    // Cursor should shift right by 5 ("ALPHA" inserted before it)
    const cursorAfterImport = peer2.view.state.selection.anchor;
    expect(cursorAfterImport).toBe(posAfterX + 5);
  });

  test("cursor stays put when remote appends text after cursor", async () => {
    const peer1 = createPeer("hello");
    const peer2 = createSyncedPeer(peer1.doc);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("hello");

    // Peer2: place cursor at beginning (pos 1) and type "X"
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 1),
      );
      peer2.view.dispatch(tr);
    }
    {
      const tr = peer2.view.state.tr.insertText("X", 1);
      peer2.view.dispatch(tr);
    }
    expect(peer2.view.state.doc.textContent).toBe("Xhello");
    const posAfterX = peer2.view.state.selection.anchor; // 2

    // Peer1: append " world" at end
    {
      const endPos = peer1.view.state.doc.content.size - 1;
      const tr = peer1.view.state.tr.insertText(" world", endPos);
      peer1.view.dispatch(tr);
    }

    // Import — remote text is AFTER cursor, so cursor should NOT move
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toContain("hello");
    expect(peer2.view.state.doc.textContent).toContain("world");

    const cursorAfterImport = peer2.view.state.selection.anchor;
    expect(cursorAfterImport).toBe(posAfterX);
  });
});

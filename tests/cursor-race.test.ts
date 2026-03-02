/**
 * Cursor race condition test.
 *
 * Exercises the exact code path that caused character interleaving:
 * calling convertPmSelectionToCursors with a STALE ProseMirror document
 * after doc.import() has already updated the Loro text.
 *
 * The old PM nodes are still in WEAK_NODE_TO_LORO_CONTAINER_MAPPING
 * (populated by a previous createNodeFromLoroObj call), so
 * absolutePositionToCursor finds the ContainerID and calls
 * loroText.getCursor(staleOffset) on the UPDATED text — returning
 * a cursor at the wrong Fugue tree position.
 *
 * The fix: save Loro Cursors when PM ↔ Loro are in sync, then reuse
 * them after import instead of calling convertPmSelectionToCursors.
 */

import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";

import {
  ROOT_DOC_KEY,
  createNodeFromLoroObj,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "../src/cursor/common";
import type { LoroSyncPluginState } from "../src/sync-plugin-key";

import { schema } from "./schema";
import { createEditorState } from "./utils";

function sync(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update" }));
}

/**
 * Build PM EditorState + mapping from Loro, using the node directly
 * from createNodeFromLoroObj so node refs match the WeakMap entries.
 */
function buildPmFromLoro(loroDoc: LoroDocType) {
  const mapping: LoroNodeMapping = new Map();
  const innerDoc = loroDoc.getMap(ROOT_DOC_KEY);
  const node = createNodeFromLoroObj(schema, innerDoc, mapping);
  const editorState = EditorState.create({ doc: node, schema });
  return { editorState, mapping };
}

function makeSyncState(
  doc: LoroDocType,
  mapping: LoroNodeMapping,
): LoroSyncPluginState {
  return { doc, mapping, changedBy: "local" };
}

describe("cursor race condition on remote import", () => {
  test("convertPmSelectionToCursors with stale PM doc produces wrong cursor after import", () => {
    const doc1: LoroDocType = new LoroDoc();
    const doc2: LoroDocType = new LoroDoc();

    // Initial: paragraph with "seed text"
    const initPm = createEditorState(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "seed text" }] },
      ],
    });
    updateLoroToPmState(doc1, new Map(), initPm);
    doc1.commit();
    sync(doc1, doc2);

    // Build PM from doc2 — the node refs are registered in the WeakMap
    // by createNodeFromLoroObj. This simulates the PM state before import.
    const { editorState: pm2Before, mapping: map2Before } =
      buildPmFromLoro(doc2);
    const endPos = 10; // 1 (para open) + 9 ("seed text")
    const sel2 = TextSelection.create(pm2Before.doc, endPos);

    // --- THE FIX: save cursor while PM ↔ Loro are in sync ---
    const { anchor: savedCursor } = convertPmSelectionToCursors(
      pm2Before.doc,
      sel2,
      makeSyncState(doc2, map2Before),
    );
    expect(savedCursor).toBeDefined();

    // Sanity: resolves to 10 before import
    expect(cursorToAbsolutePosition(savedCursor!, doc2, map2Before)[0]).toBe(
      10,
    );

    // --- User1 inserts "A" at position 0 ---
    const { mapping: map1 } = buildPmFromLoro(doc1);
    updateLoroToPmState(
      doc1,
      map1,
      createEditorState(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Aseed text" }],
          },
        ],
      }),
    );
    doc1.commit();

    // Remote import — doc2's Loro now has "Aseed text" but pm2Before is STALE
    sync(doc1, doc2);

    // --- THE BUG: convertPmSelectionToCursors with stale PM doc ---
    // This is what the original updateNodeOnLoroEvent did:
    //   1. clearChangedNodes + createNodeFromLoroObj (updates mapping)
    //   2. convertPmSelectionToCursors(view.state.doc, view.state.selection, state)
    //      where view.state.doc is STALE (old PM) but state.doc is UPDATED (Loro)
    //
    // The old PM nodes are still in WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
    // so absolutePositionToCursor finds the ContainerID and creates a
    // Loro cursor at the stale parentOffset against the updated LoroText.
    const { anchor: staleCursor } = convertPmSelectionToCursors(
      pm2Before.doc, // STALE PM doc — "seed text" (9 chars)
      sel2, // Selection at position 10 (end of "seed text")
      makeSyncState(doc2, map2Before), // doc2 Loro is UPDATED ("Aseed text")
    );

    // The stale cursor is created at offset 9 in "Aseed text" (10 chars).
    // Offset 9 in "Aseed text" is between 'x' and 't' — NOT at the end.
    expect(staleCursor).toBeDefined();

    // Rebuild mapping from updated Loro (for cursorToAbsolutePosition)
    const { mapping: map2After } = buildPmFromLoro(doc2);

    // Stale cursor resolves to PM position 10 — inside the text, not at end
    const [staleResolvedPos] = cursorToAbsolutePosition(
      staleCursor!,
      doc2,
      map2After,
    );
    expect(staleResolvedPos).toBe(10); // Wrong: should be 11

    // --- THE FIX: saved cursor resolves correctly ---
    const [fixedResolvedPos] = cursorToAbsolutePosition(
      savedCursor!,
      doc2,
      map2After,
    );
    expect(fixedResolvedPos).toBe(11); // Correct: 1 + 10 ("Aseed text")

    // The stale approach is off by the number of remotely inserted characters
    expect(fixedResolvedPos - staleResolvedPos!).toBe(1); // "A" = 1 char
  });

  test("stale cursor divergence grows with more remote inserts", () => {
    const doc1: LoroDocType = new LoroDoc();
    const doc2: LoroDocType = new LoroDoc();

    const initPm = createEditorState(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "seed text" }] },
      ],
    });
    updateLoroToPmState(doc1, new Map(), initPm);
    doc1.commit();
    sync(doc1, doc2);

    // Save cursor at end while in sync
    const { editorState: pm2, mapping: map2 } = buildPmFromLoro(doc2);
    const sel2 = TextSelection.create(pm2.doc, 10);
    const { anchor: savedCursor } = convertPmSelectionToCursors(
      pm2.doc,
      sel2,
      makeSyncState(doc2, map2),
    );
    expect(savedCursor).toBeDefined();

    // User1 types "ALPHA" one char at a time at position 0
    let currentText = "seed text";
    for (let i = 0; i < 5; i++) {
      currentText =
        currentText.slice(0, i) + "ALPHA"[i] + currentText.slice(i);
      const { mapping: map1 } = buildPmFromLoro(doc1);
      updateLoroToPmState(
        doc1,
        map1,
        createEditorState(schema, {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: currentText }],
            },
          ],
        }),
      );
      doc1.commit();
      sync(doc1, doc2);
    }

    // Verify: "ALPHAseed text" (14 chars)
    const loroJson = doc2.getMap(ROOT_DOC_KEY).toJSON() as any;
    expect(loroJson.children[0].children[0]).toBe("ALPHAseed text");

    const { mapping: map2Final } = buildPmFromLoro(doc2);

    // Stale approach: convertPmSelectionToCursors with OLD PM after ALL imports
    const { anchor: staleCursor } = convertPmSelectionToCursors(
      pm2.doc, // OLD PM — "seed text"
      sel2, // OLD position 10
      makeSyncState(doc2, map2), // doc2 Loro now has "ALPHAseed text"
    );
    expect(staleCursor).toBeDefined();

    const [stalePos] = cursorToAbsolutePosition(
      staleCursor!,
      doc2,
      map2Final,
    );
    // Stale: offset 9 in "ALPHAseed text" is 'e' (in "seed") — position 10
    expect(stalePos).toBe(10); // Wrong

    // Saved cursor: adjusts for all 5 inserted characters
    const [fixedPos] = cursorToAbsolutePosition(
      savedCursor!,
      doc2,
      map2Final,
    );
    expect(fixedPos).toBe(15); // Correct: 1 + 5 (ALPHA) + 9 (seed text)

    // Divergence equals number of remotely inserted characters
    expect(fixedPos - stalePos!).toBe(5);
  });
});

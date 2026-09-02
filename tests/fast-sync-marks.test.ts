/**
 * @vitest-environment jsdom
 *
 * `fastTextSync` must insert remote text with the REMOTE delta's marks, not
 * the local mark context (storedMarks / `$from.marks()`) at the insertion
 * point. A remote peer prepending bold "X" to a bold span at a plain|bold
 * junction produces identical span structure, so the mark-structure check
 * passes -- but the local marks at that junction are plain. Inserting with
 * local context would store plain "X" while Loro holds bold "X": a permanent
 * mark divergence between peers.
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
function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

describe("fastTextSync preserves remote marks", () => {
  test("a remote bold prepend at a plain|bold junction stays bold locally", async () => {
    // Seed: paragraph [ text("ab"), bold text("cd") ]
    const doc1: LoroDocType = new LoroDoc();
    const pm1 = createEditorState(schema, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "ab" },
            { type: "text", marks: [{ type: "bold" }], text: "cd" },
          ],
        },
      ],
    });
    updateLoroToPmState(doc1, new Map() as LoroNodeMapping, pm1);
    doc1.commit();

    const view1 = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        schema,
        plugins: [LoroSyncPlugin({ doc: doc1, fastTextSync: true })],
      }),
    });
    const doc2: LoroDocType = new LoroDoc();
    sync(doc1, doc2);
    const view2 = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        schema,
        plugins: [LoroSyncPlugin({ doc: doc2, fastTextSync: true })],
      }),
    });
    views.push(view1, view2);
    await flushTimer();

    expect(view1.state.doc.textContent).toBe("abcd");
    expect(view2.state.doc.textContent).toBe("abcd");

    // Peer 1 prepends a BOLD "X" at the plain|bold junction: paragraph opens
    // at 0, "a" is 1, "b" is 2, so the junction before "cd" is 3.
    {
      const junction = 3;
      const tr = view1.state.tr.setSelection(
        TextSelection.create(view1.state.doc, junction),
      );
      tr.replaceWith(
        junction,
        junction,
        schema.text("X", [schema.marks.bold.create()]),
      );
      view1.dispatch(tr);
    }
    expect(view1.state.doc.textContent).toBe("abXcd");

    // Import into peer 2: updateNodeOnLoroEvent → tryFastTextSync inserts "X".
    sync(doc1, doc2);
    await flushTimer();

    expect(view2.state.doc.textContent).toBe("abXcd");
    // The inserted "X" (PM range [3, 4)) carries the remote delta's bold mark,
    // not the plain marks in force at the junction.
    expect(view2.state.doc.rangeHasMark(3, 4, schema.marks.bold)).toBe(true);
  });
});

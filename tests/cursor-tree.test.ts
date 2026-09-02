/**
 * @vitest-environment jsdom
 *
 * Cursor translation on the tree layout. Without it every position resolves
 * to undefined: remote peer cursors never render, and `savedAnchor` stays
 * unset so every remote-import rebuild (the fast text path does not apply to
 * a tree) drops the local caret to the end and concurrent typing interleaves
 * character by character.
 */
import { describe, expect, it, afterEach } from "vitest";
import { LoroDoc, type Cursor } from "loro-crdt";
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import {
  convertPmSelectionToCursors,
  resolveCursorPosition,
} from "../src/cursor/common";
import { type LoroDocType, type LoroNodeMapping } from "../src/lib";
import { updateLoroTree } from "../src/tree-diff";
import { getRootTree, TEXT_KEY, TEXT_NODE_NAME } from "../src/tree-build";
import { treeStrategy } from "../src/tree-strategy";
import { LoroSyncPlugin } from "../src/sync-plugin";
import type { LoroSyncPluginState } from "../src/sync-plugin-key";
import { schema } from "./schema";

// p1 "seed text" opens at 0, text spans 1..10, closes at 10;
// p2 "second" opens at 11, text spans 12..18.
function twoParagraphs() {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("seed text")]),
    schema.node("paragraph", null, [schema.text("second")]),
  ]);
}

function treeSetup(pmRoot = twoParagraphs()) {
  const doc: LoroDocType = new LoroDoc();
  const mapping: LoroNodeMapping = new Map();
  updateLoroTree(getRootTree(doc), pmRoot, mapping);
  doc.commit();
  const loroState = {
    doc,
    mapping,
    changedBy: "import",
    strategy: treeStrategy,
  } as unknown as LoroSyncPluginState;
  return { loroState, pmRoot };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

describe("cursor round-trip on a tree document", () => {
  it.each([
    [1, "start of the first text run"],
    [5, "middle of the first text run"],
    [10, "end of the first text run"],
    [13, "inside the second paragraph (ancestor sibling summation)"],
  ])("PM pos %i (%s) round-trips stably", (pos) => {
    const { loroState, pmRoot } = treeSetup();
    const selection = { anchor: pos, head: pos } as unknown as TextSelection;
    const { anchor } = convertPmSelectionToCursors(
      pmRoot,
      selection,
      loroState,
    );
    expect(anchor).toBeDefined();
    const [back] = resolveCursorPosition(anchor!, loroState);
    expect(back).toBe(pos);
  });

  it("round-trips across an inline atom between text runs", () => {
    const atomSchema = new Schema({
      nodes: {
        doc: { content: "block*" },
        paragraph: {
          content: "inline*",
          group: "block",
          toDOM: () => ["p", 0],
        },
        link_inline: {
          inline: true,
          atom: true,
          group: "inline",
          toDOM: () => ["a", { class: "link" }],
        },
        text: { group: "inline" },
      },
      topNode: "doc",
    });
    // 'ab' → 1..3, atom → 3..4, 'cd' → 4..6
    const pmRoot = atomSchema.node("doc", null, [
      atomSchema.node("paragraph", null, [
        atomSchema.text("ab"),
        atomSchema.node("link_inline"),
        atomSchema.text("cd"),
      ]),
    ]);
    const { loroState } = treeSetup(pmRoot);

    for (const pos of [2, 5, 6]) {
      const selection = { anchor: pos, head: pos } as unknown as TextSelection;
      const { anchor } = convertPmSelectionToCursors(
        pmRoot,
        selection,
        loroState,
      );
      expect(anchor, `pos ${pos}`).toBeDefined();
      const [back] = resolveCursorPosition(anchor!, loroState);
      expect(back, `pos ${pos}`).toBe(pos);
    }
  });

  it("a peer's cursor resolves on a replica that imported the tree", () => {
    const { loroState } = treeSetup();

    // Peer B replicates the doc and anchors a cursor at "second" offset 1
    // (PM pos 13) in its replica — the wire shape a presence store carries.
    const docB: LoroDocType = new LoroDoc();
    docB.import(loroState.doc.export({ mode: "snapshot" }));
    const p2 = getRootTree(docB).roots()[0].children()![1];
    const textNode = p2.children()![0];
    expect(textNode.data.get("nodeName")).toBe(TEXT_NODE_NAME);
    const textB = textNode.data.get(TEXT_KEY) as {
      getCursor(i: number): Cursor | undefined;
    };
    const remoteCursor = textB.getCursor(1);
    expect(remoteCursor).toBeDefined();

    const [pos] = resolveCursorPosition(remoteCursor!, loroState);
    expect(pos).toBe(13);
  });
});

describe("selection restore across a remote import (tree full rebuild)", () => {
  it("keeps the local caret in place when a peer's edit arrives", async () => {
    const docA: LoroDocType = new LoroDoc();
    const viewA = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        schema,
        doc: twoParagraphs(),
        plugins: [
          LoroSyncPlugin({
            doc: docA,
            container: treeStrategy,
            seedFromEditor: true,
          }),
        ],
      }),
    });
    views.push(viewA);
    await flush();

    viewA.dispatch(
      viewA.state.tr.setSelection(TextSelection.create(viewA.state.doc, 1)),
    );
    viewA.dispatch(viewA.state.tr.insertText("A", 1));
    await flush();
    expect(viewA.state.doc.textContent).toBe("Aseed textsecond");
    expect(viewA.state.selection.from).toBe(2);

    // Peer B appends at the end of the first paragraph concurrently.
    const docB: LoroDocType = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const p1TextNode = getRootTree(docB)
      .roots()[0]
      .children()![0]
      .children()![0];
    const textB = p1TextNode.data.get(TEXT_KEY) as {
      length: number;
      insert(i: number, s: string): void;
    };
    textB.insert(textB.length, "BRAVO");
    docB.commit();

    docA.import(docB.export({ mode: "update", from: docA.version() }));
    await flush();

    expect(viewA.state.doc.textContent).toBe("Aseed textBRAVOsecond");
    // The caret still sits after "A", not at the end of the rebuilt paragraph.
    expect(viewA.state.selection.from).toBe(2);
  });
});

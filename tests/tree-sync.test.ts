/**
 * @vitest-environment jsdom
 *
 * The sync plugin over the tree layout: a local edit writes a LoroTree, a
 * fresh peer reads it back, and sequential edits accumulate without
 * duplicating `$text` children.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { LoroDoc, type Change } from "loro-crdt";
import { schema } from "./schema";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { treeStrategy } from "../src/tree-strategy";
import { getRootTree } from "../src/tree-build";
import { LoroOrigins } from "../src/origins";
import { ROOT_DOC_KEY, type LoroDocType } from "../src/lib";

function pmDoc(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, text ? [schema.text(text)] : []),
  ]);
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function changesOf(doc: LoroDocType): Change[] {
  const [changes] = doc.getAllChanges().values();
  return changes ?? [];
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

function open(doc: LoroDocType, text: string) {
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      schema,
      doc: pmDoc(text),
      plugins: [
        LoroSyncPlugin({ doc, container: treeStrategy, seedFromEditor: true }),
      ],
    }),
  });
  views.push(view);
  return view;
}

describe("sync plugin over treeStrategy", () => {
  it("seeds a LoroTree from the editor; a fresh peer reads it back", async () => {
    const doc: LoroDocType = new LoroDoc();
    open(doc, "Tree hello");
    await flush();

    expect(getRootTree(doc).roots().length).toBe(1);
    // The nested root was never touched.
    expect(doc.getMap(ROOT_DOC_KEY).size).toBe(0);

    const doc2: LoroDocType = new LoroDoc();
    doc2.import(doc.export({ mode: "snapshot" }));
    const view2 = open(doc2, "");
    await flush();

    expect(view2.state.doc.textContent).toBe("Tree hello");
  });

  it("sequential edits accumulate without duplicating text children", async () => {
    const doc: LoroDocType = new LoroDoc();
    const view = open(doc, "v1");
    await flush();

    const p2 = schema.node("paragraph", null, [schema.text("v2")]);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, p2));
    await flush();

    expect(getRootTree(doc).roots().length).toBe(1);
    expect(view.state.doc.textContent).toBe("v1v2");

    const doc2: LoroDocType = new LoroDoc();
    doc2.import(doc.export({ mode: "snapshot" }));
    const view2 = open(doc2, "");
    await flush();

    expect(view2.state.doc.childCount).toBe(2);
    expect(view2.state.doc.textContent).toBe("v1v2");
  });

  it("mirrors origin into the commit message, keeping bootstrap and edit distinct", async () => {
    const doc: LoroDocType = new LoroDoc();
    const view = open(doc, "v1");
    await flush();

    const afterBootstrap = changesOf(doc);
    expect(afterBootstrap).toHaveLength(1);
    expect(afterBootstrap[0]?.message).toBe(LoroOrigins.sysInit);

    const p2 = schema.node("paragraph", null, [schema.text("v2")]);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, p2));
    await flush();

    // Without distinct messages these same-peer commits fall inside Loro's
    // default merge interval and collapse into one change, erasing the
    // bootstrap boundary.
    const afterEdit = changesOf(doc);
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit[0]?.message).toBe(LoroOrigins.sysInit);
    expect(afterEdit[1]?.message).toBe(LoroOrigins.userEdit);
  });

  it("renders a remote deletion of every block as an empty document", async () => {
    const doc: LoroDocType = new LoroDoc();
    const view = open(doc, "gone");
    await flush();

    // A peer removes every block; the import is what the plugin renders.
    const peer: LoroDocType = new LoroDoc();
    peer.import(doc.export({ mode: "snapshot" }));
    const tree = getRootTree(peer);
    for (const child of tree.roots()[0].children() ?? []) tree.delete(child.id);
    peer.commit();
    doc.import(peer.export({ mode: "update", from: doc.version() }));
    await flush();

    expect(view.state.doc.textContent).toBe("");
    expect(view.state.doc.childCount).toBe(0);
  });
});

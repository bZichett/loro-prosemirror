/**
 * @vitest-environment jsdom
 *
 * Undo across an incoming remote update on text stored in a tree node's meta
 * map — where the tree layout keeps all inline text.
 *
 * On loro-crdt 1.13.7 an undo entry for such an op was destroyed by a remote
 * import: `undo()` returned true, reverted nothing, and consumed the entry.
 * 1.13.9 fixed it. Every shape below asserts the correct behaviour directly;
 * measured green on 1.10.6 and 1.13.9, so the regression was confined to the
 * releases between.
 */
import { describe, expect, it, afterEach } from "vitest";
import { LoroDoc, LoroText, UndoManager } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { type LoroDocType, type LoroNodeMapping } from "../src/lib";
import { LoroOrigins } from "../src/origins";
import { buildLoroTree, getRootTree, TEXT_KEY } from "../src/tree-build";
import { treeStrategy } from "../src/tree-strategy";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { LoroUndoPlugin, undo } from "../src/undo-plugin";
import { schema } from "./schema";

function pmDoc(text: string) {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text(text)]),
  ]);
}

/** Build a tree doc via the production write path. */
function treeDoc(text: string) {
  const doc: LoroDocType = new LoroDoc();
  const mapping: LoroNodeMapping = new Map();
  buildLoroTree(getRootTree(doc), undefined, pmDoc(text), mapping);
  doc.commit({ origin: LoroOrigins.sysInit });
  return { doc, text1: firstText(doc) };
}

function firstText(doc: LoroDocType): LoroText {
  return getRootTree(doc)
    .roots()[0]
    .children()![0]
    .children()![0]
    .data.get(TEXT_KEY) as LoroText;
}

function fork(doc: LoroDocType) {
  const replica: LoroDocType = new LoroDoc();
  replica.import(doc.export({ mode: "snapshot" }));
  return { doc: replica, text1: firstText(replica) };
}

function importFrom(from: LoroDocType, into: LoroDocType) {
  into.import(from.export({ mode: "update", from: into.version() }));
}

function makeUndoManager(doc: LoroDocType) {
  return new UndoManager(doc as unknown as LoroDoc, {
    excludeOriginPrefixes: [LoroOrigins.sysNamespace],
  });
}

describe("raw UndoManager on tree-meta text", () => {
  it("undo with no imports reverts the edit (control)", () => {
    const a = treeDoc("seed");
    const um = makeUndoManager(a.doc);
    a.text1.insert(4, " FROM_A");
    a.doc.commit();

    expect(um.undo()).toBe(true);
    expect(a.text1.toString()).toBe("seed");
  });

  it("undo of an edit made BEFORE a sequential remote edit reverts it and keeps the remote text", () => {
    const a = treeDoc("seed");
    const um = makeUndoManager(a.doc);
    a.text1.insert(4, " FROM_A");
    a.doc.commit();

    const b = fork(a.doc);
    b.text1.insert(b.text1.length, " FROM_B");
    b.doc.commit();
    importFrom(b.doc, a.doc);

    expect(um.undo()).toBe(true);
    expect(a.text1.toString()).toBe("seed FROM_B");
  });

  it("undo of an edit made AFTER an import reverts it", () => {
    const a = treeDoc("seed");
    const um = makeUndoManager(a.doc);
    const b = fork(a.doc);
    b.text1.insert(4, " FROM_B");
    b.doc.commit();
    importFrom(b.doc, a.doc);

    a.text1.insert(a.text1.length, " FROM_A");
    a.doc.commit();

    expect(um.undo()).toBe(true);
    expect(a.text1.toString()).toBe("seed FROM_B");
  });

  it("undo of an edit merged with a CONCURRENT remote edit reverts it", () => {
    const a = treeDoc("seed");
    const um = makeUndoManager(a.doc);
    const b = fork(a.doc);
    a.text1.insert(4, " FROM_A");
    a.doc.commit();
    b.text1.insert(4, " FROM_B");
    b.doc.commit();
    importFrom(b.doc, a.doc);

    expect(um.undo()).toBe(true);
    expect(a.text1.toString()).not.toContain("FROM_A");
  });
});

describe("plugin stack: two users undo independently", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const v of views) if (!v.isDestroyed) v.destroy();
    views.length = 0;
  });

  function makePeer(doc: LoroDocType) {
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        schema,
        doc: pmDoc("seed"),
        plugins: [
          LoroSyncPlugin({ doc, container: treeStrategy, collaboration: true }),
          LoroUndoPlugin({ doc }),
        ],
      }),
    });
    views.push(view);
    return view;
  }

  function typeAtEnd(view: EditorView, text: string) {
    const end = view.state.doc.content.size - 1;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, end)),
    );
    view.dispatch(view.state.tr.insertText(text, end));
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("both users undo their own edit independently", async () => {
    // A server materialises the doc; both peers import it before typing.
    const server = treeDoc("seed");
    const snapshot = server.doc.export({ mode: "snapshot" });

    const docA: LoroDocType = new LoroDoc();
    const viewA = makePeer(docA);
    await flush();
    docA.import(snapshot);
    await flush();

    const docB: LoroDocType = new LoroDoc();
    const viewB = makePeer(docB);
    await flush();
    docB.import(snapshot);
    await flush();

    typeAtEnd(viewA, " FROM_A");
    await flush();
    importFrom(docA, docB);
    await flush();
    expect(viewB.state.doc.textContent).toBe("seed FROM_A");

    typeAtEnd(viewB, " FROM_B");
    await flush();
    importFrom(docB, docA);
    await flush();
    expect(viewA.state.doc.textContent).toBe("seed FROM_A FROM_B");

    expect(undo(viewA.state, viewA.dispatch)).toBe(true);
    await flush();
    expect(viewA.state.doc.textContent).toBe("seed FROM_B");

    importFrom(docA, docB);
    await flush();
    expect(viewB.state.doc.textContent).toBe("seed FROM_B");
    expect(undo(viewB.state, viewB.dispatch)).toBe(true);
    await flush();

    importFrom(docB, docA);
    await flush();
    expect(viewB.state.doc.textContent).toBe("seed");
    expect(viewA.state.doc.textContent).toBe("seed");
  });
});

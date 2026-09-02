/**
 * @vitest-environment jsdom
 *
 * `fastTextSync` at the view level: remote plain-text edits are applied as
 * targeted ProseMirror steps, so cursors and node selections are remapped by
 * ProseMirror instead of being reset by a document replace. The fallback
 * cases -- structural change, mark-only change, an unmapped or empty target,
 * an exception inside the fast path -- must all still leave the document
 * correct via the full rebuild.
 */

import { afterEach, describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { type LoroDocType } from "../src/lib";
import {
  loroSyncPluginKey,
  type LoroSyncPluginState,
} from "../src/sync-plugin-key";

import {
  createPeer,
  createSyncedPeer,
  flushTimer,
  seedLoroWith,
  sync,
  viewOver,
} from "./peers";

const FAST = { fastTextSync: true } as const;

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

describe("Incremental sync: NodeSelection preserved for text-only remote edits", () => {
  test("select HR → remote text insert in sibling paragraph → NodeSelection preserved", async () => {
    // Seed doc with: paragraph("hello") + horizontal_rule + paragraph("world")
    const doc1: LoroDocType = new LoroDoc();
    seedLoroWith(doc1, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "horizontal_rule" },
        { type: "paragraph", content: [{ type: "text", text: "world" }] },
      ],
    });
    const peer1 = { doc: doc1, view: viewOver(doc1, FAST) };

    const peer2 = createSyncedPeer(doc1, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    expect(peer2.view.state.doc.childCount).toBe(3);
    expect(peer2.view.state.doc.child(1).type.name).toBe("horizontal_rule");

    // Peer2: select the HR
    const hrPos = peer2.view.state.doc.content.child(0).nodeSize;
    {
      const tr = peer2.view.state.tr.setSelection(
        NodeSelection.create(peer2.view.state.doc, hrPos),
      );
      peer2.view.dispatch(tr);
    }
    expect(peer2.view.state.selection).toBeInstanceOf(NodeSelection);

    // Peer1: insert "ABC" in first paragraph (text-only change)
    {
      const tr = peer1.view.state.tr.insertText("ABC", 1);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // With incremental sync: PM's Mapping shifts the NodeSelection position
    // automatically. The HR is still there, just shifted by 3.
    expect(peer2.view.state.doc.textContent).toContain("ABChello");
    expect(peer2.view.state.selection).toBeInstanceOf(NodeSelection);
    expect(peer2.view.state.selection.$anchor.nodeAfter?.type.name).toBe(
      "horizontal_rule",
    );
  });
});

describe("Incremental sync: cursor position correct after remote delete", () => {
  test("remote deletes character under cursor → cursor position adjusted", async () => {
    const peer1 = createPeer("ABCDE", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor on "C" (position 3)
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 3),
      );
      peer2.view.dispatch(tr);
    }
    expect(peer2.view.state.selection.anchor).toBe(3);

    // Peer1: delete "B" (position 2-3, before cursor)
    {
      const tr = peer1.view.state.tr.delete(2, 3);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("ACDE");
    // Cursor was at 3 ("C"), "B" was deleted before it → cursor shifts left to 2
    expect(peer2.view.state.selection.anchor).toBe(2);
  });

  test("remote deletes character at cursor → cursor stays at same position", async () => {
    const peer1 = createPeer("ABCDE", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor on "C" (position 3)
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 3),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: delete "C" (position 3-4, at cursor)
    {
      const tr = peer1.view.state.tr.delete(3, 4);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("ABDE");
    // Cursor was between B and C. C deleted → cursor at same position (now between B and D)
    expect(peer2.view.state.selection.anchor).toBe(3);
  });
});

describe("Incremental sync: multiple containers in one batch", () => {
  test("two paragraphs edited remotely in one import → both updated correctly", async () => {
    // Seed doc with two paragraphs
    const doc1: LoroDocType = new LoroDoc();
    seedLoroWith(doc1, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    });
    const peer1 = { doc: doc1, view: viewOver(doc1, FAST) };
    const peer2 = createSyncedPeer(doc1, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: place cursor at start of second paragraph
    {
      const secondParaStart =
        peer2.view.state.doc.content.child(0).nodeSize + 1;
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, secondParaStart),
      );
      peer2.view.dispatch(tr);
    }
    const cursorBefore = peer2.view.state.selection.anchor;

    // Peer1: edit both paragraphs (single commit → one import batch)
    {
      let tr = peer1.view.state.tr;
      tr = tr.insertText("A", 1); // insert in first para
      const secondParaStart = tr.doc.content.child(0).nodeSize + 1;
      tr = tr.insertText("B", secondParaStart); // insert in second para
      peer1.view.dispatch(tr);
    }
    peer1.doc.commit();
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toContain("Afirst");
    expect(peer2.view.state.doc.textContent).toContain("Bsecond");
    // Cursor was at start of "second" → shifted by "A" in first para (+1)
    // and by "B" inserted before cursor in second para (+1) = cursorBefore + 2
    expect(peer2.view.state.selection.anchor).toBe(cursorBefore + 2);
  });
});

describe("Incremental sync: coalesced same-container edits", () => {
  test("two separate commits on same text → imported together → coalesced into one diff", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor at end
    {
      const endPos = peer2.view.state.doc.content.size - 1;
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, endPos),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: two separate edits to the same paragraph, two commits
    {
      const tr1 = peer1.view.state.tr.insertText("A", 1);
      peer1.view.dispatch(tr1);
    }
    peer1.doc.commit();
    {
      const tr2 = peer1.view.state.tr.insertText("B", 2);
      peer1.view.dispatch(tr2);
    }
    peer1.doc.commit();

    // Import both commits at once → Loro fires events for the same LoroText
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("ABhello");
    // Cursor was at end (6), two chars inserted before → now at 8
    expect(peer2.view.state.selection.anchor).toBe(8);
  });
});

describe("Incremental sync: selection at textblock boundary", () => {
  test("cursor at end of paragraph → remote inserts at start → cursor stays at end", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor at end of text (position 6, after "o")
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 6),
      );
      peer2.view.dispatch(tr);
    }
    expect(peer2.view.state.selection.anchor).toBe(6);

    // Peer1: insert "XYZ" at start of paragraph
    {
      const tr = peer1.view.state.tr.insertText("XYZ", 1);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("XYZhello");
    // Cursor was at 6, 3 chars inserted before it → now at 9
    expect(peer2.view.state.selection.anchor).toBe(9);
  });

  test("cursor at start of paragraph → remote appends at end → cursor stays at start", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor at start (position 1)
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 1),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: append at end
    {
      const tr = peer1.view.state.tr.insertText(" world", 6);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("hello world");
    // Cursor at start, remote appended after → stays at 1
    expect(peer2.view.state.selection.anchor).toBe(1);
  });
});

describe("Incremental sync: IME-like replacement", () => {
  test("remote replaces text span (delete + insert) → handled as single contiguous edit", async () => {
    const peer1 = createPeer("hello world", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer2: cursor at end
    {
      const endPos = peer2.view.state.doc.content.size - 1;
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, endPos),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: replace "world" with "earth" (delete 5, insert 5 at same position)
    {
      const tr = peer1.view.state.tr.insertText("earth", 7, 12);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("hello earth");
  });
});

describe("Incremental sync: typing inside marked text", () => {
  test("remote types inside bold span → mark structure unchanged → handled incrementally", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer1: bold entire text first
    {
      const tr = peer1.view.state.tr.addMark(
        1,
        6,
        peer1.view.state.schema.marks.bold.create(),
      );
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Verify peer2 has bold text
    expect(peer2.view.state.doc.child(0).child(0).marks.length).toBe(1);

    // Peer2: place cursor at position 3
    {
      const tr = peer2.view.state.tr.setSelection(
        TextSelection.create(peer2.view.state.doc, 3),
      );
      peer2.view.dispatch(tr);
    }

    // Peer1: type "XY" inside bold span (mark structure doesn't change — still one bold span)
    {
      const tr = peer1.view.state.tr.insertText("XY", 3);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.textContent).toBe("heXYllo");
    // Bold mark should still be present
    expect(peer2.view.state.doc.child(0).child(0).marks.length).toBe(1);
    // Cursor should shift right by 2 (insert before cursor)
    expect(peer2.view.state.selection.anchor).toBe(5);
  });
});

describe("Incremental sync: fallback to full rebuild", () => {
  test("structural change (node insertion) → falls back, document still correct", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer1: add a new paragraph (structural change, not text-only)
    {
      const paraNode = peer1.view.state.schema.nodes.paragraph.create(
        null,
        peer1.view.state.schema.text("new para"),
      );
      const tr = peer1.view.state.tr.insert(
        peer1.view.state.doc.content.size,
        paraNode,
      );
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Document should be correct (full rebuild handles it)
    expect(peer2.view.state.doc.childCount).toBe(2);
    expect(peer2.view.state.doc.textContent).toContain("hello");
    expect(peer2.view.state.doc.textContent).toContain("new para");
  });

  test("mixed text + structural events → falls back, document correct", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer1: insert text AND add a new paragraph in one commit
    {
      const paraNode = peer1.view.state.schema.nodes.paragraph.create(
        null,
        peer1.view.state.schema.text("new"),
      );
      let tr = peer1.view.state.tr;
      tr = tr.insertText("X", 1); // text change
      tr = tr.insert(tr.doc.content.size, paraNode); // structural change
      peer1.view.dispatch(tr);
    }
    peer1.doc.commit();
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    expect(peer2.view.state.doc.childCount).toBe(2);
    expect(peer2.view.state.doc.textContent).toContain("Xhello");
    expect(peer2.view.state.doc.textContent).toContain("new");
  });

  test("empty paragraph receives remote text → falls back, document correct", async () => {
    // Seed doc with: paragraph("hello") + empty paragraph
    const doc1: LoroDocType = new LoroDoc();
    seedLoroWith(doc1, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
        { type: "paragraph" },
      ],
    });
    const peer1 = { doc: doc1, view: viewOver(doc1, FAST) };
    const peer2 = createSyncedPeer(doc1, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer1: type into empty paragraph
    {
      const emptyParaPos = peer1.view.state.doc.content.child(0).nodeSize + 1;
      const tr = peer1.view.state.tr.insertText("typed", emptyParaPos);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Falls back (empty LoroText → non-empty), but document still correct
    expect(peer2.view.state.doc.textContent).toContain("typed");
  });

  test("mark-only change (bold applied) → falls back, document correct", async () => {
    const peer1 = createPeer("hello world", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Peer1: bold "world" (mark change, same text)
    {
      const tr = peer1.view.state.tr.addMark(
        7, // start of "world"
        12, // end of "world"
        peer1.view.state.schema.marks.bold.create(),
      );
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Document text unchanged, but marks should be applied
    expect(peer2.view.state.doc.textContent).toBe("hello world");
    // Verify bold mark is present on "world"
    const paraNode = peer2.view.state.doc.child(0);
    const lastChild = paraNode.child(paraNode.childCount - 1);
    expect(lastChild.marks.some((m) => m.type.name === "bold")).toBe(true);
  });

  test("target container missing from mapping → falls back, document correct", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Corrupt peer2's mapping by clearing it — the LoroText container
    // won't be found, so tryFastTextSync should bail
    const state2 = loroSyncPluginKey.getState(
      peer2.view.state,
    ) as LoroSyncPluginState;
    state2.mapping.clear();

    // Peer1: text edit
    {
      const tr = peer1.view.state.tr.insertText("X", 1);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // Full rebuild handles it — document still correct
    expect(peer2.view.state.doc.textContent).toBe("Xhello");
  });

  test("incremental sync exception → corrective full rebuild, document correct", async () => {
    const peer1 = createPeer("hello", FAST);
    const peer2 = createSyncedPeer(peer1.doc, FAST);
    views.push(peer1.view, peer2.view);
    await flushTimer();

    // Poison the mapping: replace the LoroText's PM text nodes entry with
    // a bogus node that will cause position resolution to find a node but
    // produce an invalid position when used with tr.insertText/delete.
    const state2 = loroSyncPluginKey.getState(
      peer2.view.state,
    ) as LoroSyncPluginState;
    for (const [cid, mapped] of state2.mapping.entries()) {
      if (Array.isArray(mapped) && mapped.length > 0 && mapped[0].isText) {
        // Replace with a fake text node that won't be found by descendants walk
        const fakeNode = peer2.view.state.schema.text("fake");
        state2.mapping.set(cid, [fakeNode]);
        break;
      }
    }

    // Peer1: text edit
    {
      const tr = peer1.view.state.tr.insertText("Y", 1);
      peer1.view.dispatch(tr);
    }
    sync(peer1.doc, peer2.doc);
    await flushTimer();

    // tryFastTextSync should fail (position resolution can't find the fake node)
    // and fall back to full rebuild — document still correct
    expect(peer2.view.state.doc.textContent).toBe("Yhello");
  });
});

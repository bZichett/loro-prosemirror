/**
 * What Loro's explicit undo groups can and cannot do, pinned.
 *
 * This package deliberately does not open an undo group around a burst of
 * typing. The idea -- keep a burst as one undo item even when a remote import
 * lands in the middle -- is sound, but at the current loro-crdt an import ends
 * an explicit group exactly as it ends the time-based merge, so the group buys
 * nothing. These tests pin that. If the second one starts failing, Loro has
 * changed and a typing group in the sync plugin becomes worth building.
 */

import { describe, expect, test } from "vitest";
import { LoroDoc, UndoManager } from "loro-crdt";

function editor() {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  doc.getText("t").insert(0, "hello");
  doc.commit({ origin: "sys:init" });
  const undo = new UndoManager(doc, { mergeInterval: 0 });
  undo.addExcludeOriginPrefix("sys:");
  const peer = new LoroDoc();
  peer.setPeerId(2);
  peer.import(doc.export({ mode: "snapshot" }));
  const text = () => doc.getText("t").toString();
  const type = (s: string) => {
    doc.getText("t").insert(doc.getText("t").length, s);
    doc.commit();
  };
  return { doc, peer, undo, text, type };
}

describe("explicit undo groups", () => {
  test("hold two commits together as one undo item", () => {
    const { undo, text, type } = editor();
    undo.groupStart();
    type("a");
    type("b");
    undo.groupEnd();

    undo.undo();
    expect(text()).toBe("hello");
    expect(undo.canUndo()).toBe(false);
  });

  test("do NOT survive a remote import landing inside the group", () => {
    const { doc, peer, undo, text, type } = editor();
    undo.groupStart();
    type("a");
    peer.getText("t").insert(0, "X");
    peer.commit();
    doc.import(peer.export({ mode: "update" }));
    type("b");
    undo.groupEnd();

    undo.undo();
    // The group was ended by the import: only the second keystroke reverts.
    expect(text()).toBe("Xhelloa");
    expect(undo.canUndo()).toBe(true);
  });
});

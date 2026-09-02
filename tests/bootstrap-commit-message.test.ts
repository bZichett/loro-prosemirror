/**
 * `Change.origin` is not app-visible in `doc.getAllChanges()` (Loro exposes it
 * only to commit-time listeners), but `Change.message` IS — so the only way for
 * a consumer like TimeTravelPanel to tell a `sys:init` bootstrap commit apart
 * from a real user edit is if `updateLoroToPmState` mirrors the origin into the
 * commit message. This pins that mirroring for both commit sites in the
 * function: the nodeName-only bootstrap commit, and the main children-sync
 * commit (default origin and caller-supplied origin alike).
 */
import { describe, expect, test } from "vitest";

import { LoroDoc, type Change } from "loro-crdt";

import {
  ROOT_DOC_KEY,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

function changesForDoc(doc: LoroDocType): Change[] {
  const [changes] = doc.getAllChanges().values();
  return changes ?? [];
}

describe("updateLoroToPmState — commit message mirrors origin", () => {
  test("bootstrap: nodeName write and children sync each carry their own origin as message", () => {
    const loroDoc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    const editorState = createEditorState(schema, { type: "doc", content: [] });

    updateLoroToPmState(loroDoc, mapping, editorState);

    const changes = changesForDoc(loroDoc);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.message).toBe("sys:init");
    expect(changes[1]?.message).toBe("loroSyncPlugin");
  });

  test("init/recovery origin folds the nodeName write into a single sys:init-tagged commit", () => {
    const loroDoc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    const editorState = createEditorState(schema, { type: "doc", content: [] });

    updateLoroToPmState(loroDoc, mapping, editorState, undefined, {
      origin: "sys:init",
    });

    const changes = changesForDoc(loroDoc);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.message).toBe("sys:init");
  });

  test("a caller-supplied origin on the main commit is mirrored into message", () => {
    const loroDoc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    loroDoc.getMap(ROOT_DOC_KEY).set("nodeName", "doc");
    loroDoc.commit();
    const editorState = createEditorState(schema, { type: "doc", content: [] });

    updateLoroToPmState(loroDoc, mapping, editorState, undefined, {
      origin: "undoManager",
    });

    const changes = changesForDoc(loroDoc);
    const lastChange = changes[changes.length - 1];
    expect(lastChange?.message).toBe("undoManager");
  });
});

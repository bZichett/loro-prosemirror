/**
 * Cursor round-trip across an inline atom on the nested layout: a paragraph
 * carrying several text containers with an atom between them. Positions in
 * the second run must not teleport back across the atom.
 */
import { describe, expect, test } from "vitest";

import { LoroDoc } from "loro-crdt";
import { Schema } from "prosemirror-model";

import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "../src/cursor/common";
import type { LoroSyncPluginState } from "../src/sync-plugin-key";

import { createEditorState } from "./utils";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: () => ["p", 0] },
    link_inline: {
      inline: true,
      atom: true,
      group: "inline",
      toDOM: () => ["a", { class: "link" }],
    },
    text: { group: "inline" },
  },
  marks: {},
  topNode: "doc",
});

// 'ab' → 1..3, atom → 3..4, 'cd' → 4..6
const docJson = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "ab" },
        { type: "link_inline" },
        { type: "text", text: "cd" },
      ],
    },
  ],
};

function setup() {
  const editorState = createEditorState(schema, docJson);
  const doc: LoroDocType = new LoroDoc();
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(doc, mapping, editorState);
  doc.commit();
  const loroState = {
    doc,
    mapping,
    changedBy: "import",
  } as unknown as LoroSyncPluginState;
  // The same root that seeded the mapping, so the paragraph resolves by identity.
  return { loroState, pmRoot: editorState.doc };
}

describe("cursor round-trip across an inline atom", () => {
  test.each([
    [5, "after 'c' in the second run"],
    [6, "after 'd' at the run end"],
    [2, "in the first run (control)"],
  ])("PM pos %i (%s) round-trips stably", (pos) => {
    const { loroState, pmRoot } = setup();
    const selection = { anchor: pos, head: pos } as any;
    const { anchor } = convertPmSelectionToCursors(
      pmRoot,
      selection,
      loroState,
    );
    expect(anchor).toBeDefined();
    const [back] = cursorToAbsolutePosition(
      anchor!,
      loroState.doc,
      loroState.mapping,
    );
    expect(back).toBe(pos);
  });
});

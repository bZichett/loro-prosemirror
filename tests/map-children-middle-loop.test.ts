import { describe, expect, test } from "vitest";

import { LoroDoc } from "loro-crdt";

import {
  ROOT_DOC_KEY,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

// Regression: updateLoroMapChildren's middle loop
// spins forever on the updateRight branch. When a single transaction removes a
// leading block of a DIFFERENT type and modifies the trailing sibling (whose
// nodeName still matches), the right-trim loop can't consume the trailing pair
// (eqLoroObjNode false — text differs) but the middle loop sees updateRight=true
// (eqNodeName true). `right += 1` mutated nothing the loop reads, so the window
// never shrank → infinite loop (browser tab freeze / loro-service event-loop wedge).
//
// This is the exact select-all-and-type / cross-block-delete delta on a
// nested Map/List document.
describe("updateLoroMapChildren middle-loop", () => {
  test("removing a leading block of a different type + editing the trailing sibling terminates", () => {
    const loroDoc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();

    // Seed: [noteTitle('head'), paragraph('para')]
    let editorState = createEditorState(schema, {
      type: "doc",
      content: [
        { type: "noteTitle", content: [{ type: "text", text: "head" }] },
        { type: "paragraph", content: [{ type: "text", text: "para" }] },
      ],
    });
    updateLoroToPmState(loroDoc, mapping, editorState);

    // Diff to: [paragraph('tail')] — drops the leading noteTitle (different type)
    // and rewrites the trailing paragraph's text. Pre-fix this hangs.
    editorState = createEditorState(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "tail" }] },
      ],
    });
    updateLoroToPmState(loroDoc, mapping, editorState);

    expect(loroDoc.toJSON()).toEqual({
      [ROOT_DOC_KEY]: {
        nodeName: "doc",
        attributes: {},
        children: [
          {
            nodeName: "paragraph",
            attributes: {},
            children: ["tail"],
          },
        ],
      },
    });
  });
});

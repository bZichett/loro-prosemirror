import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";

import { nestedListStrategy } from "../src/container-strategy";
import {
  getLoroMapChildren,
  ROOT_DOC_KEY,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

/**
 * `isEmpty` decides whether a null read means "render an empty document" or
 * "leave the content alone", so it must say empty only for a root whose blocks
 * are actually gone -- never for a container it could not read.
 */
describe("nestedListStrategy.isEmpty", () => {
  test("a populated root is not empty, and becomes empty once every block is removed", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map() as LoroNodeMapping,
      createEditorState(schema, {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    );
    doc.commit();
    expect(nestedListStrategy.isEmpty({ doc })).toBe(false);

    const children = getLoroMapChildren(doc.getMap(ROOT_DOC_KEY));
    children.delete(0, children.length);
    doc.commit();
    expect(nestedListStrategy.isEmpty({ doc })).toBe(true);
  });

  test("an unreadable children container is reported as NOT empty", () => {
    // A root with no `children` container at all is a broken read, not an
    // empty document. Reporting it empty would let the update path blank a
    // document whose content it merely failed to load.
    const doc: LoroDocType = new LoroDoc();
    doc.getMap(ROOT_DOC_KEY).set("nodeName", "doc");
    doc.commit();

    expect(nestedListStrategy.isEmpty({ doc })).toBe(false);
  });
});

describe("nestedListStrategy.isUnpopulated", () => {
  test("true before anything is written, false after the first sync", () => {
    const doc: LoroDocType = new LoroDoc();
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(true);

    updateLoroToPmState(
      doc,
      new Map() as LoroNodeMapping,
      createEditorState(schema, { type: "doc", content: [] }),
    );
    doc.commit();
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(false);
  });
});

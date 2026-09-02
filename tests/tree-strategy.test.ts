/**
 * `treeStrategy`'s root predicates, and the seam between them.
 *
 * `isEmpty` is what lets the update path tell a blockless root (a real state,
 * rendered as an empty document) from content the schema rejects (which must
 * not be blanked). `isUnpopulated` is what init consults to decide whether to
 * seed from the editor.
 */
import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { schema } from "./schema";
import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import { buildLoroTree } from "../src/tree-build";
import { treeStrategy } from "../src/tree-strategy";
import { nestedListStrategy } from "../src/container-strategy";

const pmDoc = () =>
  schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
  });

describe("treeStrategy", () => {
  test("isEmpty flips to true once every block is removed", () => {
    const doc: LoroDocType = new LoroDoc();
    const tree = (doc as LoroDoc).getTree(ROOT_DOC_KEY);
    buildLoroTree(tree, undefined, pmDoc(), new Map() as LoroNodeMapping);
    doc.commit();

    expect(treeStrategy.isEmpty({ doc })).toBe(false);

    for (const child of tree.roots()[0].children() ?? []) {
      tree.delete(child.id);
    }
    doc.commit();

    expect(treeStrategy.isEmpty({ doc })).toBe(true);
  });

  test("a rootless tree is both unpopulated and empty", () => {
    const doc: LoroDocType = new LoroDoc();
    (doc as LoroDoc).getTree(ROOT_DOC_KEY);
    doc.commit();

    expect(treeStrategy.isUnpopulated({ doc })).toBe(true);
    expect(treeStrategy.isEmpty({ doc })).toBe(true);
  });

  test("isUnpopulated is false once a root exists, and honours rootKey", () => {
    const doc: LoroDocType = new LoroDoc();
    buildLoroTree(
      (doc as LoroDoc).getTree("tree"),
      undefined,
      pmDoc(),
      new Map() as LoroNodeMapping,
    );
    doc.commit();

    expect(treeStrategy.isUnpopulated({ doc, rootKey: "tree" })).toBe(false);
    expect(
      treeStrategy.read({ doc, rootKey: "tree" }, new Map(), schema)
        ?.textContent,
    ).toBe("hi");
  });

  test("write then read round-trips through the strategy", () => {
    const doc: LoroDocType = new LoroDoc();
    const editorState = EditorState.create({ schema, doc: pmDoc() });
    const mapping: LoroNodeMapping = new Map();
    treeStrategy.write({ doc }, mapping, editorState);

    expect(treeStrategy.isUnpopulated({ doc })).toBe(false);
    // The nested root stays untouched: the two layouts do not share a container.
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(true);
    const read = treeStrategy.read({ doc }, new Map(), schema);
    expect(read?.eq(pmDoc())).toBe(true);
  });

  test("declares no fast paths", () => {
    expect(treeStrategy.fastPaths).toBe(false);
  });
});

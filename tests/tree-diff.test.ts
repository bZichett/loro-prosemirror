import { describe, expect, test } from "vitest";
import { LoroDoc, type LoroText, type LoroTreeNode } from "loro-crdt";
import { schema } from "./schema";
import { ROOT_DOC_KEY, type LoroNodeMapping } from "../src/lib";
import { buildLoroTree, TEXT_KEY } from "../src/tree-build";
import { updateLoroTree } from "../src/tree-diff";

// A paragraph's inline text lives in its first `$text` child.
const paraText = (para: LoroTreeNode): LoroText =>
  para.children()![0].data.get(TEXT_KEY) as LoroText;

describe("updateLoroTree (PM -> LoroTree diff, native moves)", () => {
  // Peer A reparents a block across parents while peer B concurrently types
  // into it. A native tree.move preserves the block's TreeID and its text
  // container, so B's edit merges; a delete plus recreate would drop it.
  test("reparent emits tree.move preserving TreeID; concurrent text survives merge", () => {
    // paraX is reused by reference in the "after" doc, reproducing the
    // structural sharing a real reparent transaction produces: an unchanged
    // subtree keeps its Node instance, only its ancestors get new ones.
    const paraX = schema.node("paragraph", null, [schema.text("hello")]);
    const paraA = schema.node("paragraph", null, [schema.text("A")]);
    const paraB = schema.node("paragraph", null, [schema.text("B")]);
    const before = schema.node("doc", null, [
      schema.node("section", null, [paraX, paraA]),
      schema.node("section", null, [paraB]),
    ]);

    const docA = new LoroDoc();
    const treeA = docA.getTree(ROOT_DOC_KEY);
    const mappingA: LoroNodeMapping = new Map();
    const rootA = buildLoroTree(treeA, undefined, before, mappingA);
    docA.commit();

    const sectionATree = rootA.children()![0];
    const sectionBTree = rootA.children()![1];
    const paraXId = sectionATree.children()![0].id;
    const sectionBId = sectionBTree.id;

    // Fork a concurrent peer and type into paraX's text.
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const treeB = docB.getTree(ROOT_DOC_KEY);
    const textB = paraText(treeB.getNodeByID(paraXId)!);
    textB.insert(textB.length, " world");
    docB.commit();

    // Peer A: reparent paraX (same instance) from sectionA to the end of sectionB.
    const after = schema.node("doc", null, [
      schema.node("section", null, [paraA]),
      schema.node("section", null, [paraB, paraX]),
    ]);
    updateLoroTree(treeA, after, mappingA);
    docA.commit();

    // Moved, not recreated: same TreeID, now under sectionB.
    expect(treeA.has(paraXId)).toBe(true);
    expect(treeA.getNodeByID(paraXId)!.parent()!.id).toBe(sectionBId);

    docA.import(docB.export({ mode: "update" }));
    docB.import(docA.export({ mode: "update" }));
    docA.commit();
    docB.commit();

    const merged = docA.getTree(ROOT_DOC_KEY).getNodeByID(paraXId)!;
    expect(paraText(merged).toString()).toBe("hello world");
    expect(merged.parent()!.id).toBe(sectionBId);
    const sectionBKids = docA
      .getTree(ROOT_DOC_KEY)
      .getNodeByID(sectionBId)!
      .children()!;
    expect(sectionBKids[sectionBKids.length - 1].id).toBe(paraXId);
  });
});

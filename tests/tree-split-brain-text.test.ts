/**
 * Split-brain `$text` children on the tree layout.
 *
 * Two peers typing into the same empty block each create their own `$text`
 * child, so the block ends up with two text containers. The read path renders
 * them as one contiguous inline run, so the next PM -> Loro diff sees a run
 * spanning both. If the diff wrote that run into just one of them, the other
 * peer's characters would be re-inserted as fresh local ops while that peer
 * still holds its own, and the merge would carry each of them twice.
 */
import { describe, expect, test } from "vitest";
import { LoroDoc, type LoroText, type LoroTreeNode } from "loro-crdt";
import { schema } from "./schema";
import { ROOT_DOC_KEY, type LoroNodeMapping } from "../src/lib";
import { buildLoroTree, TEXT_KEY } from "../src/tree-build";
import { treeToPmNode } from "../src/tree-read";
import { updateLoroTree } from "../src/tree-diff";

const allText = (para: LoroTreeNode): string =>
  (para.children() ?? [])
    .map(
      (c) => (c.data.get(TEXT_KEY) as LoroText | undefined)?.toString() ?? "",
    )
    .join("");

describe("split-brain $text children (tree layout)", () => {
  test("a peer's diff does not re-insert the other peer's characters", () => {
    const empty = schema.node("doc", null, [
      schema.node("paragraph", null, []),
    ]);

    const docA = new LoroDoc();
    const treeA = docA.getTree(ROOT_DOC_KEY);
    const mappingA: LoroNodeMapping = new Map();
    buildLoroTree(treeA, undefined, empty, mappingA);
    docA.commit();

    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const treeB = docB.getTree(ROOT_DOC_KEY);
    const mappingB: LoroNodeMapping = new Map();
    treeToPmNode(treeB, schema, mappingB);

    // Concurrent first keystroke on each peer: each creates its own `$text`.
    updateLoroTree(
      treeA,
      schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("A")]),
      ]),
      mappingA,
    );
    docA.commit();
    updateLoroTree(
      treeB,
      schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("B")]),
      ]),
      mappingB,
    );
    docB.commit();

    docA.import(docB.export({ mode: "update" }));
    docB.import(docA.export({ mode: "update" }));
    expect(treeA.roots()[0].children()![0].children()!.length).toBe(2);
    expect(treeB.roots()[0].children()![0].children()!.length).toBe(2);

    // Both peers do what the plugin does on a remote event: rebuild from
    // Loro, then write back the next local keystroke — concurrently, since
    // with only one peer diffing its delete of the sibling container would
    // cancel the duplicate write.
    const typeOneMore = (
      tree: typeof treeA,
      mapping: LoroNodeMapping,
      doc: LoroDoc,
      ch: string,
    ) => {
      const merged = treeToPmNode(tree, schema, mapping)!.child(0).textContent;
      updateLoroTree(
        tree,
        schema.node("doc", null, [
          schema.node("paragraph", null, [schema.text(merged + ch)]),
        ]),
        mapping,
      );
      doc.commit();
    };
    typeOneMore(treeA, mappingA, docA, "A");
    typeOneMore(treeB, mappingB, docB, "B");

    docB.import(docA.export({ mode: "update" }));
    docA.import(docB.export({ mode: "update" }));

    // Each peer typed its own character twice: exactly two A's and two B's.
    const finalA = allText(
      docA.getTree(ROOT_DOC_KEY).roots()[0].children()![0],
    );
    const finalB = allText(
      docB.getTree(ROOT_DOC_KEY).roots()[0].children()![0],
    );
    expect(finalA).toBe(finalB);
    expect({
      a: (finalA.match(/A/g) ?? []).length,
      b: (finalA.match(/B/g) ?? []).length,
      length: finalA.length,
    }).toEqual({ a: 2, b: 2, length: 4 });
  });
});

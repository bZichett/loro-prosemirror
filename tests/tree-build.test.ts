import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { schema } from "./schema";
import { ROOT_DOC_KEY, type LoroNodeMapping } from "../src/lib";
import { buildLoroTree, TEXT_NODE_NAME } from "../src/tree-build";

const meta = (n: { meta: unknown }): Record<string, unknown> =>
  n.meta as Record<string, unknown>;

describe("buildLoroTree (PM -> LoroTree)", () => {
  test("builds nested block structure with text runs as tree children", () => {
    const pmDoc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "hello" }],
                },
              ],
            },
          ],
        },
      ],
    });

    const doc = new LoroDoc();
    const tree = doc.getTree(ROOT_DOC_KEY);
    const mapping: LoroNodeMapping = new Map();
    const rootNode = buildLoroTree(tree, undefined, pmDoc, mapping);
    doc.commit();

    // doc -> bulletList -> listItem -> paragraph -> $text("hello")
    const json = rootNode.toJSON();
    expect(meta(json).nodeName).toBe("doc");

    const bulletList = json.children[0];
    expect(meta(bulletList).nodeName).toBe("bulletList");

    const listItem = bulletList.children[0];
    expect(meta(listItem).nodeName).toBe("listItem");

    const paragraph = listItem.children[0];
    expect(meta(paragraph).nodeName).toBe("paragraph");

    // The paragraph's inline text is a tree child, not a list sibling.
    const textNode = paragraph.children[0];
    expect(meta(textNode).nodeName).toBe(TEXT_NODE_NAME);
    expect(meta(textNode).text).toBe("hello");

    // Every block and text run is keyed in the mapping by its meta ContainerID.
    expect(mapping.size).toBe(5);
  });
});

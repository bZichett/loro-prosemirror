import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { schema } from "./schema";
import { ROOT_DOC_KEY, type LoroNodeMapping } from "../src/lib";
import { buildLoroTree } from "../src/tree-build";
import { treeToPmNode } from "../src/tree-read";

function roundTrip(pmDoc: ReturnType<typeof schema.nodeFromJSON>) {
  const doc = new LoroDoc();
  const tree = doc.getTree(ROOT_DOC_KEY);
  const writeMapping: LoroNodeMapping = new Map();
  buildLoroTree(tree, undefined, pmDoc, writeMapping);
  doc.commit();

  const readMapping: LoroNodeMapping = new Map();
  const readBack = treeToPmNode(tree, schema, readMapping);
  return { readBack, readMapping, writeMapping };
}

describe("treeToPmNode (LoroTree -> PM)", () => {
  test("round-trips nested block + text structure", () => {
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

    const { readBack } = roundTrip(pmDoc);
    expect(readBack).not.toBeNull();
    expect(readBack!.eq(pmDoc)).toBe(true);
  });

  test("round-trips inline marks (bold/italic) on a text run", () => {
    const pmDoc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
          ],
        },
      ],
    });

    const { readBack } = roundTrip(pmDoc);
    expect(readBack).not.toBeNull();
    expect(readBack!.eq(pmDoc)).toBe(true);
  });

  test("read mapping keys every block + text-run node by its meta ContainerID", () => {
    const pmDoc = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });

    const { readMapping } = roundTrip(pmDoc);
    // doc + paragraph + $text run
    expect(readMapping.size).toBe(3);
  });

  test("a node the schema rejects is reported and left out, not thrown", () => {
    // listItem requires a leading paragraph; a bare listItem violates it.
    const doc = new LoroDoc();
    const tree = doc.getTree(ROOT_DOC_KEY);
    const root = tree.createNode();
    root.data.set("nodeName", "doc");
    const list = root.createNode();
    list.data.set("nodeName", "bulletList");
    const item = list.createNode();
    item.data.set("nodeName", "listItem");
    doc.commit();

    const violations: string[] = [];
    const readBack = treeToPmNode(tree, schema, new Map(), {
      onSchemaViolation: (info) => violations.push(info.nodeName ?? "?"),
    });
    expect(violations).toEqual(["listItem", "bulletList"]);
    expect(readBack?.childCount).toBe(0);
  });
});

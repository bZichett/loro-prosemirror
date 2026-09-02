import { describe, expect, test } from "vitest";

import { LoroDoc } from "loro-crdt";

import {
  ROOT_DOC_KEY,
  createNodeFromLoroObj,
  getLoroMapChildren,
  tryGetLoroMapAttributes,
  tryGetLoroMapChildren,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { insertLoroMap, insertLoroText } from "./utils";

/**
 * A root whose `attributes` container was never created must still hydrate.
 *
 * A server-built document can legitimately omit the root's attributes
 * container when the root has no attributes to store. The reader used to treat
 * that as fatal and return null, so every such document rendered blank while
 * Loro held its content. Missing attributes are an empty attribute set; only a
 * missing `children` container drops a node (see detached-checkout.test.ts).
 */
describe("attribute-less root node", () => {
  // Root `doc` with a populated `children` container but no `attributes`
  // container. insertLoroMap gives the child paragraph its own containers; the
  // root's attributes container is deliberately never created.
  function buildRootWithoutAttributes(): LoroDocType {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    root.set("nodeName", "doc");
    const children = getLoroMapChildren(root);
    const para = insertLoroMap(children, "paragraph");
    insertLoroText(getLoroMapChildren(para)).insert(0, "Hello");
    doc.commit();
    return doc;
  }

  test("root with children but no attributes container still hydrates", () => {
    const doc = buildRootWithoutAttributes();
    const root = doc.getMap(ROOT_DOC_KEY);

    // Precondition: the root genuinely has no attributes container, but does have
    // children — the asymmetry that previously produced a null root.
    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
    expect(tryGetLoroMapChildren(root)).not.toBeUndefined();

    const mapping: LoroNodeMapping = new Map();
    const node = createNodeFromLoroObj(schema, root, mapping);

    // Before the fix: null → blank editor. After: the doc rebuilds with content.
    expect(node).not.toBeNull();
    expect(node?.type.name).toBe("doc");
    expect(node?.childCount).toBe(1);
    expect(node?.textContent).toBe("Hello");
  });
});

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
import {
  insertBareLoroMap,
  insertLoroMap,
  insertLoroText,
  setupLoroMap,
} from "./utils";

/**
 * The read path must not write.
 *
 * A time-travel checkout puts the LoroDoc into detached mode, which is
 * read-only: any mutation -- including `getOrCreateContainer`, which
 * auto-commits -- throws "Auto commit has not started". Rebuilding the editor
 * document walks the historical Loro tree, so it has to stay on the pure-read
 * accessors.
 *
 * The frontier that trips this is the bootstrap commit: `updateLoroToPmState`
 * records the root's `nodeName` before the `children` / `attributes`
 * containers exist. Checking out to it reaches a node map with a name and no
 * nested containers. A creating accessor there crashes the rebuild, and the
 * editor is stuck showing the head while Loro is detached underneath.
 */
describe("detached-doc read path", () => {
  // Build a doc whose bootstrap frontier has the root `nodeName` set but no
  // `children` container yet — mirroring updateLoroToPmState's sys:init flush.
  function buildBootstrapThenContent(): {
    doc: LoroDocType;
    bootstrapFrontier: ReturnType<LoroDocType["frontiers"]>;
  } {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);

    root.set("nodeName", "doc");
    doc.commit({ origin: "sys:init" });
    const bootstrapFrontier = doc.frontiers();

    // Later commit: now the children container is created and populated.
    const children = getLoroMapChildren(root);
    const p1 = insertLoroMap(children, "paragraph");
    insertLoroText(getLoroMapChildren(p1)).insert(0, "Hello");
    doc.commit({ origin: "loroSyncPlugin" });

    return { doc, bootstrapFrontier };
  }

  test("tryGet* return undefined for an absent nested container without mutating", () => {
    const { doc, bootstrapFrontier } = buildBootstrapThenContent();

    doc.checkout(bootstrapFrontier);
    expect(doc.isDetached()).toBe(true);

    const root = doc.getMap(ROOT_DOC_KEY);
    // children/attributes were created in a LATER commit, so they don't exist
    // at the bootstrap frontier — pure reads must surface that as undefined.
    expect(tryGetLoroMapChildren(root)).toBeUndefined();
    expect(tryGetLoroMapAttributes(root)).toBeUndefined();
    // The reads must not have attached / auto-committed the doc.
    expect(doc.isDetached()).toBe(true);
  });

  test("createNodeFromLoroObj does not auto-commit when a nested container is absent", () => {
    const { doc, bootstrapFrontier } = buildBootstrapThenContent();
    const mapping: LoroNodeMapping = new Map();

    doc.checkout(bootstrapFrontier);
    expect(doc.isDetached()).toBe(true);

    // Old behaviour: getLoroMapAttributes -> getOrCreateContainer -> auto-commit
    // -> "Auto commit has not started". A regression THROWS on the next line —
    // surfacing that exact crash as the single, accurate failure (not a stacked,
    // misleading "expected undefined to be null"). On success the read path drops
    // the node and returns null rather than materializing a container.
    const node = createNodeFromLoroObj(
      schema,
      doc.getMap(ROOT_DOC_KEY),
      mapping,
    );

    // No valid PM representation at this frontier (no children container yet).
    expect(node).toBeNull();
    // The traversal left the doc detached — it never committed.
    expect(doc.isDetached()).toBe(true);
  });

  test("a nested node missing its container is dropped; parent rebuilds, no throw", () => {
    // Exercises the RECURSIVE descent, not just the root: a deep paragraph with
    // `nodeName` but no `children`/`attributes` container at the frontier must be
    // dropped by createNodeFromLoroObj's `mappedChildren.filter(n => n !== null)`,
    // while the (fully-formed) root still rebuilds. Guards against a regression
    // that reintroduces a creating accessor inside the child loop while keeping
    // the root guard — which the root-only tests above would NOT catch.
    const doc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    const root = doc.getMap(ROOT_DOC_KEY);
    setupLoroMap(root, "doc"); // root gets its children + attributes containers

    // Bare paragraph: nodeName only, NO nested containers yet.
    const rootChildren = getLoroMapChildren(root);
    const para = insertBareLoroMap(rootChildren, "paragraph");
    doc.commit({ origin: "sys:init" });
    const frontier = doc.frontiers();

    // Later commit: the paragraph finally gets its children container + text.
    insertLoroText(getLoroMapChildren(para)).insert(0, "Hi");
    doc.commit({ origin: "loroSyncPlugin" });

    doc.checkout(frontier);
    expect(doc.isDetached()).toBe(true);

    const node = createNodeFromLoroObj(
      schema,
      doc.getMap(ROOT_DOC_KEY),
      mapping,
    );
    // Root rebuilds; the container-less paragraph child is dropped, leaving an
    // empty doc — proving the recursion stays on the pure-read path too.
    expect(node).not.toBeNull();
    expect(node?.type.name).toBe("doc");
    expect(node?.childCount).toBe(0);
  });

  test("write accessor getLoroMapChildren still throws on a detached doc (positive control)", () => {
    // The whole point of the read/write split: the WRITE variant must KEEP its
    // create-and-throw behaviour on a detached doc. If this ever stops throwing,
    // getLoroMapChildren has silently become a pure read, the split is moot, and
    // the tryGet* assertions above no longer prove anything.
    const { doc, bootstrapFrontier } = buildBootstrapThenContent();
    doc.checkout(bootstrapFrontier);
    expect(doc.isDetached()).toBe(true);

    const root = doc.getMap(ROOT_DOC_KEY);
    expect(() => getLoroMapChildren(root)).toThrow();
  });
});

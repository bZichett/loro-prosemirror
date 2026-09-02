/**
 * The `LoroTree` layout: write side.
 *
 * Every content item — block or inline text run — is a tree node, so sibling
 * order and reparenting are uniform, and a moved block keeps its identity (and
 * therefore its text container) across the move. The nested Map/List layout
 * has no move: a reparent there is a delete plus an insert, and a concurrent
 * edit inside the moved block is lost.
 *
 * A tree node's meta map holds the same keys the nested layout puts on a node
 * map — `nodeName` and `attributes` — and a `$text` node additionally holds its
 * run's `LoroText` under `text`. The meta map's ContainerID keys the mapping,
 * so the mapping has the same shape as on the nested path.
 */

import {
  type Delta,
  type LoroDoc,
  LoroMap,
  LoroText,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
} from "loro-crdt";
import type { Node } from "prosemirror-model";
import {
  ATTRIBUTES_KEY,
  type LoroDocType,
  type LoroNodeMapping,
  NODE_NAME_KEY,
  nodeMarksToAttributes,
  normalizeNodeContent,
  ROOT_DOC_KEY,
} from "./lib";

/** `nodeName` of a tree node holding a run of ProseMirror text nodes. */
export const TEXT_NODE_NAME = "$text";
/** Meta-map key under which a `$text` node stores its run's `LoroText`. */
export const TEXT_KEY = "text";

/**
 * A block's `TreeID`, by ProseMirror node instance. ProseMirror keeps the
 * instance of any subtree a transaction did not touch, so a reparented block
 * arrives in the next document with the same instance and resolves here to
 * the tree node it already has; the diff then emits `tree.move` instead of a
 * delete and an insert. Populated by the build, read and diff paths.
 */
export const WEAK_NODE_TO_TREE_ID = new WeakMap<Node, TreeID>();

/**
 * The top-level tree holding the document. Never call this on a document
 * laid out as a nested Map/List: asking Loro for a tree root creates one.
 */
export function getRootTree(
  doc: LoroDoc | LoroDocType,
  rootKey: string = ROOT_DOC_KEY,
): LoroTree {
  return (doc as LoroDoc).getTree(rootKey);
}

/**
 * Build a ProseMirror node and its subtree into the tree. `parent` undefined
 * means the document root; `index` positions the node among its siblings.
 */
export function buildLoroTree(
  tree: LoroTree,
  parent: LoroTreeNode | undefined,
  node: Node,
  mapping: LoroNodeMapping,
  index?: number,
): LoroTreeNode {
  const treeNode = parent ? parent.createNode(index) : tree.createNode();
  const meta = treeNode.data;
  meta.set(NODE_NAME_KEY, node.type.name);

  const attrs = meta.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap());
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value !== null) {
      attrs.set(key, value);
    }
  }

  let i = 0;
  for (const item of normalizeNodeContent(node)) {
    if (Array.isArray(item)) {
      createTextNode(treeNode, i, item, mapping);
    } else {
      buildLoroTree(tree, treeNode, item, mapping, i);
    }
    i++;
  }

  mapping.set(meta.id, node);
  WEAK_NODE_TO_TREE_ID.set(node, treeNode.id);
  return treeNode;
}

/**
 * Create a `$text` child at `index` under `parent` carrying `run`, and map the
 * run by its `LoroText` id — the same key the nested path's `createLoroText`
 * uses, so `updateLoroText` serves both layouts.
 */
export function createTextNode(
  parent: LoroTreeNode,
  index: number,
  run: Node[],
  mapping: LoroNodeMapping,
): LoroTreeNode {
  const textNode = parent.createNode(index);
  textNode.data.set(NODE_NAME_KEY, TEXT_NODE_NAME);
  const text = textNode.data.getOrCreateContainer(TEXT_KEY, new LoroText());
  const delta: Delta<string>[] = run.map((n) => ({
    insert: n.text!,
    attributes: nodeMarksToAttributes(n.marks),
  }));
  text.applyDelta(delta);
  mapping.set(text.id, run);
  return textNode;
}

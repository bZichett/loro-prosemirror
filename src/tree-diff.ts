/**
 * The `LoroTree` layout: diff a new ProseMirror document into an existing
 * tree — the analogue of `updateLoroMap` on the nested path.
 *
 * A block whose ProseMirror instance survived the transaction is found by
 * identity and moved with `tree.move`, so a reparent keeps the block's
 * `TreeID` and its text container, and a concurrent edit inside it merges.
 *
 * Two passes: reconcile the structure top-down, claiming every tree node the
 * new document still references (moving or creating as needed); then delete
 * whatever was left unclaimed. Deferring the delete is what makes a block
 * that leaves one parent and reappears under another a move, never a drop.
 */

import { equalityDeep } from "lib0/function";
import {
  LoroMap,
  LoroText,
  type LoroTree,
  type LoroTreeNode,
  type TreeID,
} from "loro-crdt";
import type { Node } from "prosemirror-model";
import {
  ATTRIBUTES_KEY,
  type LoroNodeMapping,
  NODE_NAME_KEY,
  normalizeNodeContent,
  reconcileSplitBrainTexts,
  updateLoroText,
} from "./lib";
import {
  buildLoroTree,
  createTextNode,
  TEXT_KEY,
  TEXT_NODE_NAME,
  WEAK_NODE_TO_TREE_ID,
} from "./tree-build";

export function updateLoroTree(
  tree: LoroTree,
  pmRoot: Node,
  mapping: LoroNodeMapping,
): void {
  const root = tree.roots()[0];
  if (root == null) {
    buildLoroTree(tree, undefined, pmRoot, mapping);
    return;
  }

  const claimed = new Set<TreeID>();
  reconcileNode(tree, root, pmRoot, mapping, claimed);

  for (const node of tree.getNodes()) {
    if (!claimed.has(node.id) && tree.has(node.id)) {
      tree.delete(node.id);
    }
  }
}

function reconcileNode(
  tree: LoroTree,
  treeNode: LoroTreeNode,
  pmNode: Node,
  mapping: LoroNodeMapping,
  claimed: Set<TreeID>,
): void {
  claimed.add(treeNode.id);

  const meta = treeNode.data;
  if (meta.get(NODE_NAME_KEY) !== pmNode.type.name) {
    meta.set(NODE_NAME_KEY, pmNode.type.name);
  }
  reconcileAttributes(meta, pmNode);
  mapping.set(meta.id, pmNode);
  WEAK_NODE_TO_TREE_ID.set(pmNode, treeNode.id);

  const desired = normalizeNodeContent(pmNode);
  // The tree slot can run ahead of the ProseMirror item index: concurrent
  // typing into one block leaves it with several `$text` children that
  // ProseMirror renders as a single run (see ensureTextChild).
  let treeIndex = 0;
  for (const item of desired) {
    if (Array.isArray(item)) {
      treeIndex += ensureTextChild(treeNode, treeIndex, item, mapping, claimed);
    } else {
      const { node: child, created } = ensureBlockChild(
        tree,
        treeNode,
        item,
        treeIndex,
        mapping,
        claimed,
      );
      treeIndex += 1;
      // A freshly built subtree is complete and already claimed. Reconciling
      // it again would re-create its `$text` children: they are claimed, so
      // ensureTextChild's reuse guard skips them and duplicates them.
      if (!created) {
        reconcileNode(tree, child, item, mapping, claimed);
      }
    }
  }
}

/**
 * Match `pmChild` to a tree node — by identity, then by position, else create
 * — placed at `index`. `created` is true only for a fresh subtree.
 */
function ensureBlockChild(
  tree: LoroTree,
  parent: LoroTreeNode,
  pmChild: Node,
  index: number,
  mapping: LoroNodeMapping,
  claimed: Set<TreeID>,
): { node: LoroTreeNode; created: boolean } {
  const existingId = WEAK_NODE_TO_TREE_ID.get(pmChild);
  if (existingId != null && tree.has(existingId)) {
    const node = tree.getNodeByID(existingId)!;
    if (node.parent()?.id !== parent.id || node.index() !== index) {
      tree.move(existingId, parent.id, index);
    }
    return { node, created: false };
  }

  // A container whose children changed gets a new ProseMirror instance but
  // keeps its slot and node name: reconcile it in place.
  const positional = parent.children()?.[index];
  if (
    positional != null &&
    !claimed.has(positional.id) &&
    positional.data.get(NODE_NAME_KEY) === pmChild.type.name
  ) {
    WEAK_NODE_TO_TREE_ID.set(pmChild, positional.id);
    return { node: positional, created: false };
  }

  const node = buildLoroTree(tree, parent, pmChild, mapping, index);
  claimSubtree(node, claimed);
  return { node, created: true };
}

/**
 * Match the inline `run` to the `$text` child or children starting at
 * `index`, diffing their text in place. Returns how many tree children were
 * consumed, all of them claimed.
 *
 * Two peers typing into the same empty block each create their own `$text`
 * child, so one ProseMirror run can span several text containers. Writing the
 * whole run into the first would re-insert the other peer's characters as
 * fresh local ops while that peer still holds its own, and the merge would
 * carry each of them twice. The run is reconciled across all of them instead,
 * applying only the genuine local delta — the same guard the nested path
 * uses.
 */
function ensureTextChild(
  parent: LoroTreeNode,
  index: number,
  run: Node[],
  mapping: LoroNodeMapping,
  claimed: Set<TreeID>,
): number {
  const kids = parent.children() ?? [];
  const siblings: LoroTreeNode[] = [];
  for (let i = index; i < kids.length; i++) {
    const kid = kids[i];
    // A run maps to consecutive `$text` children; anything else ends it.
    if (claimed.has(kid.id) || kid.data.get(NODE_NAME_KEY) !== TEXT_NODE_NAME) {
      break;
    }
    siblings.push(kid);
  }

  if (siblings.length === 0) {
    claimed.add(createTextNode(parent, index, run, mapping).id);
    return 1;
  }

  for (const sibling of siblings) claimed.add(sibling.id);
  const texts = siblings
    .map((s) => s.data.get(TEXT_KEY))
    .filter((t): t is LoroText => t instanceof LoroText);

  if (texts.length === 1) {
    updateLoroText(texts[0], run, mapping);
  } else if (texts.length > 1) {
    reconcileSplitBrainTexts(texts, run, mapping);
  }
  return siblings.length;
}

function reconcileAttributes(meta: LoroMap, pmNode: Node): void {
  const attrs = meta.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap());
  const stale = new Set(attrs.keys());
  for (const [key, value] of Object.entries(pmNode.attrs)) {
    if (value !== null) {
      if (!equalityDeep(attrs.get(key), value)) {
        attrs.set(key, value);
      }
    } else if (attrs.get(key) != null) {
      attrs.delete(key);
    }
    stale.delete(key);
  }
  for (const key of stale) {
    attrs.delete(key);
  }
}

function claimSubtree(node: LoroTreeNode, claimed: Set<TreeID>): void {
  claimed.add(node.id);
  for (const child of node.children() ?? []) {
    claimSubtree(child, claimed);
  }
}

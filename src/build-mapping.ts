/**
 * Build a LoroNodeMapping by walking an existing PM doc and Loro tree in
 * parallel.
 *
 * When Loro was pre-populated from the PM state, the two trees are
 * structurally identical. The standard init path rebuilds the PM doc from Loro
 * via createNodeFromLoroObj + tr.replace, which destroys plugin decorations.
 * This function builds the mapping without touching the PM doc.
 *
 * Call this instead of createNodeFromLoroObj when the content is expected to
 * match; it reports a mismatch rather than repairing one.
 */

import { LoroMap, LoroText } from "loro-crdt";
import type { Node as PmNode } from "prosemirror-model";
import {
  type LoroNodeMapping,
  type LoroNodeContainerType,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
  tryGetLoroMapChildren,
} from "./lib";

/**
 * Walk the Loro tree and existing PM doc in parallel, recording
 * container → node associations in the mapping. No PM nodes are created and
 * no transactions are dispatched.
 *
 * Returns true if the walk completed (the trees match structurally). Returns
 * false on any mismatch, in which case the caller should fall back to the full
 * createNodeFromLoroObj + replace path. The mapping may be partially filled on
 * a false return; clear it before reuse.
 */
export function buildMappingFromExistingDoc(
  loroRoot: LoroMap<LoroNodeContainerType>,
  pmRoot: PmNode,
  mapping: LoroNodeMapping,
): boolean {
  return walkNode(loroRoot, pmRoot, mapping);
}

function walkNode(
  loroMap: LoroMap<LoroNodeContainerType>,
  pmNode: PmNode,
  mapping: LoroNodeMapping,
): boolean {
  mapping.set(loroMap.id, pmNode);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pmNode, loroMap.id);

  // Read path: use the pure `tryGet*` reader, never the creating
  // `getLoroMapChildren`. A missing `children` container here (for example a
  // detached historical frontier) must fall back to a full rebuild, not
  // auto-commit and throw.
  const loroChildren = tryGetLoroMapChildren(loroMap);
  if (loroChildren === undefined) {
    return false;
  }
  const loroLen = loroChildren.length;

  // PM stores text as runs of text nodes (one per mark set), while Loro stores
  // text as a single LoroText with rich-text deltas, so one LoroText matches a
  // group of consecutive PM text nodes.
  let loroIdx = 0;
  let pmIdx = 0;

  while (loroIdx < loroLen && pmIdx < pmNode.childCount) {
    const loroChild = loroChildren.get(loroIdx);

    if (loroChild instanceof LoroMap) {
      const pmChild = pmNode.child(pmIdx);
      if (pmChild.isText) {
        // Loro has a map where PM has text.
        return false;
      }
      if (
        !walkNode(loroChild as LoroMap<LoroNodeContainerType>, pmChild, mapping)
      ) {
        return false;
      }
      loroIdx++;
      pmIdx++;
    } else if (loroChild instanceof LoroText) {
      const textNodes: PmNode[] = [];
      while (pmIdx < pmNode.childCount && pmNode.child(pmIdx).isText) {
        textNodes.push(pmNode.child(pmIdx));
        pmIdx++;
      }
      if (textNodes.length === 0) {
        // Loro has text where PM has no text children.
        return false;
      }
      mapping.set(loroChild.id, textNodes);
      loroIdx++;
    } else {
      return false;
    }
  }

  // Both sides must be exhausted.
  return loroIdx === loroLen && pmIdx === pmNode.childCount;
}

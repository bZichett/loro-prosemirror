/**
 * Build a LoroNodeMapping by walking an existing PM doc and Loro tree in parallel.
 *
 * When Loro was pre-populated from the PM state (deterministic bootstrap), the
 * two trees are structurally identical. The standard init path rebuilds the PM
 * doc from Loro via createNodeFromLoroObj + tr.replace, which destroys plugin
 * decorations. This function builds the mapping without touching the PM doc.
 *
 * Call this instead of createNodeFromLoroObj when you know the content matches.
 */

import { LoroMap, LoroText } from "loro-crdt";
import type { Node as PmNode } from "prosemirror-model";
import {
  type LoroNodeMapping,
  type LoroNodeContainerType,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
  getLoroMapChildren,
} from "./lib";

/**
 * Walk the Loro tree and existing PM doc in parallel, recording container→node
 * associations in the mapping. No PM nodes are created; no transactions dispatched.
 *
 * Returns true if the walk completed successfully (trees match structurally).
 * Returns false if a mismatch is detected — caller should fall back to the
 * full createNodeFromLoroObj + replace path.
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
  // Record this node in both mappings
  mapping.set(loroMap.id, pmNode);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pmNode, loroMap.id);

  const loroChildren = getLoroMapChildren(loroMap);
  const loroLen = loroChildren.length;

  // Walk PM children, matching against Loro children by index.
  // PM stores text as runs of text nodes (one per mark set), while
  // Loro stores text as a single LoroText with rich-text deltas.
  // We need to match LoroText → PM text node group.
  let loroIdx = 0;
  let pmIdx = 0;

  while (loroIdx < loroLen && pmIdx < pmNode.childCount) {
    const loroChild = loroChildren.get(loroIdx);

    if (loroChild instanceof LoroMap) {
      const pmChild = pmNode.child(pmIdx);
      if (pmChild.isText) {
        // Structure mismatch: Loro has a map where PM has text
        return false;
      }
      if (!walkNode(loroChild as LoroMap<LoroNodeContainerType>, pmChild, mapping)) {
        return false;
      }
      loroIdx++;
      pmIdx++;
    } else if (loroChild instanceof LoroText) {
      // Collect consecutive PM text nodes that correspond to this LoroText
      const textNodes: PmNode[] = [];
      while (pmIdx < pmNode.childCount && pmNode.child(pmIdx).isText) {
        textNodes.push(pmNode.child(pmIdx));
        pmIdx++;
      }
      if (textNodes.length === 0) {
        // Loro has text where PM has no text children — mismatch
        return false;
      }
      mapping.set(loroChild.id, textNodes);
      loroIdx++;
    } else {
      // Unexpected container type
      return false;
    }
  }

  // Both sides should be exhausted
  if (loroIdx !== loroLen || pmIdx !== pmNode.childCount) {
    return false;
  }

  return true;
}

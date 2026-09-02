/**
 * The `LoroTree` layout: cursor translation. The analogues of
 * `absolutePositionToCursor` and `cursorToAbsolutePosition` in
 * `cursor/common.ts`, walking tree siblings instead of a `children` list.
 */

import {
  type Cursor,
  LoroText,
  type LoroTree,
  type LoroTreeNode,
} from "loro-crdt";
import type { Node } from "prosemirror-model";
import { type LoroDocType, type LoroNodeMapping, NODE_NAME_KEY } from "./lib";
import { TEXT_KEY, TEXT_NODE_NAME, WEAK_NODE_TO_TREE_ID } from "./tree-build";

/**
 * Bind a ProseMirror position to a stable cursor inside the `$text` run it
 * falls in. The containing block resolves by node identity; the document root
 * is recovered structurally, since ProseMirror rebuilds the top node on every
 * `tr.replace` and its identity never survives a sync.
 */
export function treePositionToCursor(
  tree: LoroTree,
  pmRootNode: Node,
  anchor: number,
): Cursor | undefined {
  const pos = pmRootNode.resolve(anchor);
  const nodeParent = pos.node(pos.depth);
  const offset = pos.parentOffset;

  let treeId = WEAK_NODE_TO_TREE_ID.get(nodeParent);
  if (treeId == null && nodeParent === pmRootNode) {
    treeId = tree.roots()[0]?.id;
  }
  if (treeId == null || !tree.has(treeId)) {
    if (anchor > 1) {
      console.warn(
        `[LoroSync] cursor: no tree node for "${nodeParent.type.name}" — skipping`,
      );
    }
    return undefined;
  }

  let index = offset;
  const children = tree.getNodeByID(treeId)?.children() ?? [];
  for (let childIndex = 0; childIndex < children.length; childIndex++) {
    const meta = children[childIndex].data;
    if (meta.get(NODE_NAME_KEY) === TEXT_NODE_NAME) {
      const text = meta.get(TEXT_KEY);
      if (!(text instanceof LoroText)) {
        continue;
      }
      // Bind when the offset falls within or at the end of this run; otherwise
      // consume the run and keep walking.
      if (index <= text.length) {
        return text.getCursor(index);
      }
      index -= text.length;
    } else {
      if (index == 0 && childIndex + 1 < children.length) {
        // Selection on an atom: bind to the start of the next run.
        index += 1;
      }
      index -= 1;
    }
  }

  // Selection is not on text.
  return undefined;
}

/**
 * Resolve a cursor inside a `$text` run to an absolute ProseMirror position:
 * the offset inside the run, plus the size of every preceding sibling at
 * every level, plus one per level for the block's opening token.
 */
export function treeCursorToAbsolutePosition(
  cursor: Cursor,
  doc: LoroDocType,
  tree: LoroTree,
  mapping: LoroNodeMapping,
): [number, Cursor | undefined] {
  const pos = doc.getCursorPos(cursor);
  if (!pos) {
    return [1, undefined];
  }

  const loroText = doc.getText(cursor.containerId());
  const metaId = loroText.parent()?.id;
  let current: LoroTreeNode | undefined;
  for (const node of tree.getNodes()) {
    if (node.data.id === metaId) {
      current = node;
      break;
    }
  }
  if (!current) {
    return [1, undefined];
  }

  let index = -1 + pos.offset;
  let parent = current.parent();
  while (parent != null) {
    for (const sibling of parent.children() ?? []) {
      if (sibling.id === current.id) {
        break;
      }
      const meta = sibling.data;
      if (meta.get(NODE_NAME_KEY) === TEXT_NODE_NAME) {
        const text = meta.get(TEXT_KEY);
        const mapped =
          text instanceof LoroText ? mapping.get(text.id) : undefined;
        if (Array.isArray(mapped)) {
          for (const child of mapped) index += child.nodeSize;
        } else if (text instanceof LoroText) {
          index += text.length;
        }
      } else {
        const mapped = mapping.get(meta.id);
        if (mapped != null && !Array.isArray(mapped)) {
          index += mapped.nodeSize;
        } else {
          console.error("[LoroSync] cursor: unmapped tree sibling", meta.id);
        }
      }
    }
    index += 1;
    current = parent;
    parent = current.parent();
  }

  return [index, pos.update];
}

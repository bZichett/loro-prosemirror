/**
 * The `LoroTree` layout: read side, the inverse of `buildLoroTree`.
 */

import { LoroMap, LoroText, type LoroTree, type LoroTreeNode } from "loro-crdt";
import type { Attrs, Node, Schema } from "prosemirror-model";
import {
  ATTRIBUTES_KEY,
  type LoroNodeMapping,
  loroTextToPmTextNodes,
  NODE_NAME_KEY,
  type RenderOptions,
} from "./lib";
import { TEXT_KEY, TEXT_NODE_NAME, WEAK_NODE_TO_TREE_ID } from "./tree-build";

/**
 * Read the tree into a ProseMirror document, repopulating `mapping` by each
 * node's meta-map ContainerID. The single tree root is the document node; a
 * `$text` child becomes a text run, every other child a block. Returns null
 * when the tree has no root.
 */
export function treeToPmNode(
  tree: LoroTree,
  schema: Schema,
  mapping: LoroNodeMapping,
  options?: RenderOptions,
): Node | null {
  const roots = tree.roots();
  if (roots.length === 0) {
    return null;
  }
  const root = treeNodeToPm(roots[0], schema, mapping, options);
  // The root is always a block; a `$text` root has no document meaning.
  return Array.isArray(root) ? null : root;
}

function treeNodeToPm(
  node: LoroTreeNode,
  schema: Schema,
  mapping: LoroNodeMapping,
  options: RenderOptions | undefined,
): Node | Node[] | null {
  const meta = node.data;
  const nodeName = meta.get(NODE_NAME_KEY);
  if (nodeName == null || typeof nodeName !== "string") {
    throw new Error("Invalid nodeName");
  }

  if (nodeName === TEXT_NODE_NAME) {
    const text = meta.get(TEXT_KEY);
    if (!(text instanceof LoroText)) {
      return null;
    }
    const nodes = loroTextToPmTextNodes(schema, text, options);
    mapping.set(text.id, nodes);
    return nodes;
  }

  const attributes = meta.get(ATTRIBUTES_KEY);
  const attrs: Attrs =
    attributes instanceof LoroMap ? (attributes.toJSON() as Attrs) : {};

  const mappedChildren = (node.children() ?? [])
    .flatMap((child) => treeNodeToPm(child, schema, mapping, options))
    .filter((n): n is Node => n !== null);

  try {
    const pmNode = schema.node(nodeName, attrs, mappedChildren);
    mapping.set(meta.id, pmNode);
    WEAK_NODE_TO_TREE_ID.set(pmNode, node.id);
    return pmNode;
  } catch (cause) {
    // As on the nested path, a node the schema rejects is left out and
    // reported rather than thrown: the content stays in Loro and reappears
    // once the conflict that produced it resolves.
    options?.unrenderable?.add(meta.id);
    if (options?.onSchemaViolation) {
      options.onSchemaViolation({ containerId: meta.id, nodeName, cause });
    } else {
      console.error(
        `[LoroSync] schema.node("${nodeName}") failed:`,
        (cause as Error).message,
        `\n  children: [${mappedChildren.map((n) => n.type.name).join(", ")}]`,
        `\n  attrs:`,
        attrs,
      );
    }
    return null;
  }
}

/**
 * The `LoroTree` layout as a {@link ContainerStrategy}.
 *
 * The document is one tree under the root name; every block and every inline
 * text run is a tree node (see `tree-build.ts`). A `containerId` is not
 * supported: a tree is a top-level container, so a document mounted inside
 * another node has to use the nested layout.
 */

import type { ContainerStrategy } from "./container-strategy";
import { LoroOrigins } from "./origins";
import { getRootTree } from "./tree-build";
import {
  treeCursorToAbsolutePosition,
  treePositionToCursor,
} from "./tree-cursor";
import { updateLoroTree } from "./tree-diff";
import { treeToPmNode } from "./tree-read";

export const treeStrategy: ContainerStrategy = {
  write(ref, mapping, editorState, origin = LoroOrigins.userEdit) {
    updateLoroTree(getRootTree(ref.doc, ref.rootKey), editorState.doc, mapping);
    // `message` mirrors `origin` for the same reason `updateLoroToPmState`
    // does: distinct messages keep a bootstrap commit and the first user edit
    // from merging into one change.
    ref.doc.commit({ origin, message: origin });
  },

  read(ref, mapping, schema, options) {
    return treeToPmNode(
      getRootTree(ref.doc, ref.rootKey),
      schema,
      mapping,
      options,
    );
  },

  isUnpopulated(ref) {
    return getRootTree(ref.doc, ref.rootKey).roots().length === 0;
  },

  isEmpty(ref) {
    // A rootless tree is only consulted here after a Loro event, where it is
    // the current state; bootstrap never reaches this predicate.
    const roots = getRootTree(ref.doc, ref.rootKey).roots();
    return roots.length === 0 || (roots[0].children()?.length ?? 0) === 0;
  },

  positionToCursor(ref, pmRootNode, pos) {
    return treePositionToCursor(
      getRootTree(ref.doc, ref.rootKey),
      pmRootNode,
      pos,
    );
  },

  cursorToPosition(ref, cursor, mapping) {
    return treeCursorToAbsolutePosition(
      cursor,
      ref.doc,
      getRootTree(ref.doc, ref.rootKey),
      mapping,
    );
  },

  fastPaths: false,
};

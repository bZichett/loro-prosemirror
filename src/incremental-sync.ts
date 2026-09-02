/**
 * Best-effort verified fast path for plain-text remote edits.
 *
 * When every event in a LoroEventBatch targets a LoroText container and the
 * change is representable as a single contiguous text edit per container, the
 * edit is applied as targeted PM steps (delete / replaceWith) instead of
 * rebuilding the whole document. PM's own step mapping then handles cursor
 * positioning and decoration remapping.
 *
 * Every eligibility check that fails returns false, and the caller performs
 * the ordinary full rebuild. After a successful dispatch the container mapping
 * is rebuilt from the new document and verified; a verification failure
 * triggers a corrective full rebuild so the two trees can never stay diverged.
 */

import { simpleDiff } from "lib0/diff";
import type { ContainerID, LoroEventBatch } from "loro-crdt";
import { LoroText } from "loro-crdt";
import type { Node as PmNode, Schema } from "prosemirror-model";
import { Fragment, Slice } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

import {
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  createNodeFromLoroObj,
  getRootContainer,
  loroTextToPmTextNodes,
} from "./lib";
import type { LoroMap } from "loro-crdt";
import { buildMappingFromExistingDoc } from "./build-mapping";
import { loroSyncPluginKey, type LoroSyncPluginState } from "./sync-plugin-key";
import { LoroOrigins } from "./origins";

const VERBOSE =
  typeof globalThis !== "undefined" &&
  (globalThis as { LORO_VERBOSE?: boolean }).LORO_VERBOSE === true;

interface TextChange {
  containerId: ContainerID;
  loroText: LoroText;
  oldTextNodes: PmNode[];
  oldText: string;
  newText: string;
  diff: { index: number; remove: number; insert: string };
  pmPosition: number;
}

/**
 * Attempt to handle a remote LoroEventBatch via targeted PM text operations.
 *
 * Returns true if the batch was handled incrementally. Returns false if any
 * eligibility check fails, in which case the caller must do a full rebuild.
 */
export function tryFastTextSync(
  view: EditorView,
  event: LoroEventBatch,
  state: LoroSyncPluginState,
): boolean {
  // Undo/redo restores structure as well as text; leave it to the full path.
  if (event.origin === LoroOrigins.undo) {
    if (VERBOSE) console.log("[LoroSync:fast] skip: undo origin");
    return false;
  }

  if (!event.events?.length) {
    if (VERBOSE) console.log("[LoroSync:fast] skip: no events");
    return false;
  }

  const doc = state.doc as LoroDocType;
  const mapping = state.mapping;

  // Coalesce events by target container: several events on one LoroText in a
  // batch should produce a single oldText → newText comparison.
  const targetIds = new Set<ContainerID>();
  for (const e of event.events) {
    targetIds.add(e.target);
  }

  const changes: TextChange[] = [];

  for (const cid of targetIds) {
    const container = doc.getContainerById(cid);
    if (!(container instanceof LoroText)) {
      if (VERBOSE) console.log("[LoroSync:fast] skip: non-text container", cid);
      return false;
    }

    // The target must already be mapped with content. An empty LoroText
    // gaining its first content has no PM text node to anchor on.
    const mapped = mapping.get(cid);
    if (!mapped || !Array.isArray(mapped) || mapped.length === 0) {
      if (VERBOSE)
        console.log("[LoroSync:fast] skip: unmapped or empty text", cid);
      return false;
    }

    const oldTextNodes = mapped as PmNode[];
    const oldText = oldTextNodes.map((n) => n.text ?? "").join("");
    const newText = container.toString();

    // A mark-only change leaves the text identical.
    if (oldText === newText) {
      if (VERBOSE) console.log("[LoroSync:fast] skip: mark-only change", cid);
      return false;
    }

    if (hasMarkChanges(container, oldTextNodes)) {
      if (VERBOSE)
        console.log("[LoroSync:fast] skip: mark structure changed", cid);
      return false;
    }

    const diff = simpleDiff(oldText, newText);
    if (diff.remove === 0 && diff.insert.length === 0) {
      if (VERBOSE) console.log("[LoroSync:fast] skip: no diff found", cid);
      return false;
    }

    changes.push({
      containerId: cid,
      loroText: container,
      oldTextNodes,
      oldText,
      newText,
      diff,
      pmPosition: -1,
    });
  }

  if (changes.length === 0) {
    if (VERBOSE) console.log("[LoroSync:fast] skip: no changes after coalesce");
    return false;
  }

  if (!resolvePositions(view.state.doc, changes)) {
    if (VERBOSE)
      console.log("[LoroSync:fast] skip: position resolution failed");
    return false;
  }

  // Back to front, so earlier edits do not invalidate later positions.
  changes.sort((a, b) => b.pmPosition - a.pmPosition);

  const tr = view.state.tr;

  for (const change of changes) {
    const start = change.pmPosition + change.diff.index;

    if (change.diff.remove > 0) {
      tr.delete(start, start + change.diff.remove);
    }
    if (change.diff.insert.length > 0) {
      // Insert with the REMOTE delta's marks, not the local storedMarks or
      // $from.marks() that tr.insertText would apply at the insertion point.
      const inserted = markedInsertNodes(view.state.schema, change);
      if (inserted == null) {
        if (VERBOSE)
          console.log("[LoroSync:fast] skip: could not derive remote marks");
        return false;
      }
      tr.replaceWith(start, start, inserted);
    }
  }

  tr.setMeta(loroSyncPluginKey, { type: "non-local-updates" });
  view.dispatch(tr);

  // Rebuild the mapping against the new document and verify it.
  const loroRoot = getRootContainer(doc, state.containerId, state.rootKey);

  mapping.clear();
  const mapSuccess = buildMappingFromExistingDoc(
    loroRoot,
    view.state.doc,
    mapping,
  );

  if (!mapSuccess) {
    if (VERBOSE) {
      console.log(
        "[LoroSync:fast] post-dispatch verification failed, corrective rebuild",
      );
    }
    correctiveFullRebuild(view, state, loroRoot, mapping);
  }

  if (VERBOSE) {
    console.log("[LoroSync:fast] success", {
      containers: changes.length,
      changes: changes.map((c) => ({
        cid: c.containerId,
        pos: c.pmPosition,
        remove: c.diff.remove,
        insert: c.diff.insert.length,
      })),
    });
  }

  return true;
}

/**
 * Build the PM text nodes for a change's inserted range, carrying the marks
 * the remote LoroText actually holds over that range, so the fast path never
 * applies the local editor's mark context to remote text.
 *
 * Returns null if the range cannot be reconstructed from the delta; the caller
 * then bails to the full rebuild, which reads marks correctly.
 */
function markedInsertNodes(
  schema: Schema,
  change: TextChange,
): PmNode[] | null {
  const full = loroTextToPmTextNodes(schema, change.loroText);
  const from = change.diff.index;
  const to = from + change.diff.insert.length;
  const out: PmNode[] = [];
  let off = 0;
  for (const node of full) {
    const text = node.text ?? "";
    const nStart = off;
    const nEnd = off + text.length;
    off = nEnd;
    const lo = Math.max(from, nStart);
    const hi = Math.min(to, nEnd);
    if (lo < hi) {
      out.push(schema.text(text.slice(lo - nStart, hi - nStart), node.marks));
    }
    if (nEnd >= to) break;
  }
  const got = out.map((n) => n.text ?? "").join("");
  return got === change.diff.insert ? out : null;
}

/**
 * Whether the mark structure of a LoroText differs from its current PM text
 * node representation: span count, and mark names per span.
 */
function hasMarkChanges(loroText: LoroText, oldTextNodes: PmNode[]): boolean {
  const newSpans = loroText
    .toDelta()
    .filter((d) => typeof d.insert === "string");

  if (newSpans.length !== oldTextNodes.length) return true;

  for (let i = 0; i < newSpans.length; i++) {
    const newAttrKeys = Object.keys(newSpans[i].attributes ?? {}).sort();
    const oldMarkNames = oldTextNodes[i].marks.map((m) => m.type.name).sort();

    if (newAttrKeys.length !== oldMarkNames.length) return true;
    for (let j = 0; j < newAttrKeys.length; j++) {
      if (newAttrKeys[j] !== oldMarkNames[j]) return true;
    }
  }

  return false;
}

/**
 * Find the absolute PM offset of each change's text start in one walk of the
 * document, matching text nodes by identity against the first node of each
 * change's `oldTextNodes`. Returns false if any target could not be resolved.
 */
function resolvePositions(pmDoc: PmNode, changes: TextChange[]): boolean {
  const nodeToChange = new Map<PmNode, number>();
  for (let i = 0; i < changes.length; i++) {
    nodeToChange.set(changes[i].oldTextNodes[0], i);
  }

  let remaining = nodeToChange.size;

  pmDoc.descendants((node, pos) => {
    if (remaining === 0) return false;
    if (node.isText) {
      const idx = nodeToChange.get(node);
      if (idx !== undefined) {
        changes[idx].pmPosition = pos;
        remaining--;
      }
    }
    return remaining > 0;
  });

  return changes.every((change) => change.pmPosition !== -1);
}

/**
 * Full rebuild after a failed post-dispatch verification. The PM document has
 * already been updated by the incremental transaction, but the Loro/PM mapping
 * diverged; rebuild PM from Loro so the two cannot drift.
 */
function correctiveFullRebuild(
  view: EditorView,
  state: LoroSyncPluginState,
  loroRoot: LoroMap<LoroNodeContainerType>,
  stateMapping: LoroNodeMapping,
): void {
  stateMapping.clear();
  const node = createNodeFromLoroObj(
    view.state.schema,
    loroRoot,
    stateMapping,
    {
      onSchemaViolation: state.onSchemaViolation,
    },
  );
  if (node == null) {
    console.warn("[LoroSync:fast] corrective rebuild produced null node");
    return;
  }

  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );
  tr.setMeta(loroSyncPluginKey, { type: "non-local-updates" });
  view.dispatch(tr);
}

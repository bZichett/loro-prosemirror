import { simpleDiff } from "lib0/diff";
import { equalityDeep } from "lib0/function";
import {
  type ContainerID,
  type Delta,
  isContainer,
  LoroDoc,
  type LoroEventBatch,
  LoroList,
  LoroMap,
  LoroText,
  LoroTree,
  type Value,
} from "loro-crdt";
import { type Attrs, Mark, Node, Schema } from "prosemirror-model";
import { type EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { LoroOrigins } from "./origins";

export type LoroChildrenListType = LoroList<
  LoroMap<LoroNodeContainerType> | LoroText
>;
export type LoroNodeContainerType = {
  [CHILDREN_KEY]: LoroChildrenListType;
  [ATTRIBUTES_KEY]: LoroMap;
  [NODE_NAME_KEY]: string;
};

export type LoroDocType = LoroDoc<{
  doc: LoroMap<LoroNodeContainerType>;
  data: LoroMap;
}>;
export type LoroNode = LoroMap<LoroNodeContainerType>;
export type LoroContainer =
  | LoroChildrenListType
  | LoroMap<LoroNodeContainerType>
  | LoroText
  | LoroTree;
export type LoroType = LoroContainer | Value;

// Mapping from a Loro Container ID to a ProseMirror non-text node
// or to the children of a ProseMirror text node.
//
// - For an non-text, it will be a LoroMap mapping to a Node
// - For a text, it will be a LoroText mapping to several Nodes.
//   (PM stores rich text as arrays of text nodes, each one with its marks,
//   and that's why we have some conversion utilities between both)
//
// So ContainerID should always be of a LoroMap or a LoroText.
// Anything else is considered an error.
//
// A PM non-text node, it has attributes and children, which represents as a
// LoroMap with a `"attributes": LoroMap` and a `"children": LoroList` inside
// of it. Both that attributes and children are just part of the parent LoroMap
// structure, which is mapped to an actual node.
//
// See also: https://prosemirror.net/docs/guide/#doc.data_structures
export type LoroNodeMapping = Map<ContainerID, Node | Node[]>;

/**
 * Reported when merged CRDT content cannot be expressed in the ProseMirror
 * schema. The grammar's sublanguage is not closed under merge, so this is a
 * normal (if rare) outcome of concurrent editing, not a programming error.
 */
export interface SchemaViolationInfo {
  /** The Loro container whose content the schema rejected. */
  containerId: ContainerID;
  /** The `nodeName` recorded on the container, when it has one. */
  nodeName?: string;
  /** What ProseMirror raised. */
  cause: unknown;
}

export interface RenderOptions {
  /** Called once per container the schema refuses to build a node from. */
  onSchemaViolation?: (info: SchemaViolationInfo) => void;
  /** If provided, receives the id of every container that rendered to nothing. */
  unrenderable?: Set<ContainerID>;
}

/**
 * Marker stored in a {@link LoroNodeMapping} for a container that exists in the
 * Loro document but produced no ProseMirror node, because the merged content
 * violates the schema.
 *
 * It is deliberately kept in the mapping rather than deleted: the write-back
 * path diffs the ProseMirror doc against the Loro doc and would otherwise read
 * the absence as a user deletion and destroy the content for every peer.
 * Compared by identity, so it can never collide with a genuinely empty text.
 */
const UNRENDERABLE = Object.freeze([]) as unknown as Node[];

/** Whether `id` names a container that could not be rendered under the schema. */
export function isUnrenderable(
  mapping: LoroNodeMapping,
  id: ContainerID,
): boolean {
  return mapping.get(id) === UNRENDERABLE;
}

export const ROOT_DOC_KEY = "doc";
export const ATTRIBUTES_KEY = "attributes";
export const CHILDREN_KEY = "children";
export const NODE_NAME_KEY = "nodeName";
/**
 * Maps PM non-text nodes to their corresponding Loro Container IDs.
 */
export const WEAK_NODE_TO_LORO_CONTAINER_MAPPING = new WeakMap<
  Node,
  ContainerID
>();

function reportViolation(
  options: RenderOptions | undefined,
  containerId: ContainerID,
  nodeName: string | undefined,
  cause: unknown,
) {
  options?.unrenderable?.add(containerId);
  if (options?.onSchemaViolation) {
    options.onSchemaViolation({ containerId, nodeName, cause });
  } else {
    console.error(cause);
  }
}

/**
 * Resolve the container holding the document.
 *
 * An explicit `containerId` wins; otherwise the document lives in a top-level
 * container named `rootKey`, defaulting to {@link ROOT_DOC_KEY}.
 *
 * The name is part of the wire format — it is baked into every persisted
 * snapshot and update — so it is an option rather than a constant. That lets an
 * application keep documents it has already written under a different name, or
 * place a second top-level container alongside the document.
 */
export function getRootContainer(
  doc: LoroDocType,
  containerId?: ContainerID,
  rootKey: string = ROOT_DOC_KEY,
): LoroMap<LoroNodeContainerType> {
  if (containerId) {
    return doc.getContainerById(containerId) as LoroMap<LoroNodeContainerType>;
  }
  // `LoroDocType` fixes its root schema to `doc` and `data`, so a name supplied
  // at runtime is by construction outside that union. Widening to the untyped
  // `LoroDoc` here is the honest statement: with `rootKey` in play the document
  // may carry roots the declared schema does not name. The returned container is
  // still asserted to the node shape, which is what the rest of the file relies
  // on.
  return (doc as LoroDoc).getMap(rootKey) as LoroMap<LoroNodeContainerType>;
}

export interface UpdateLoroOptions {
  /** See {@link getRootContainer}. Ignored when a `containerId` is given. */
  rootKey?: string;
  /**
   * Commit origin. Defaults to `LoroOrigins.userEdit`, which the UndoManager
   * tracks; init and recovery writes pass `LoroOrigins.sysInit` to stay off
   * the undo stack.
   */
  origin?: string;
}

/**
 * Sync the editor document into Loro.
 *
 * The first write to a root also records its `nodeName`. When the enclosing
 * commit would be undo-tracked, that write is flushed first in its own
 * `sysInit` commit: otherwise undoing back past it would remove the
 * `nodeName` and leave a root the reader cannot rebuild. When the caller is
 * already committing under `sysInit`, the write is folded into the same
 * commit, so history never holds a bar with a named root and no children —
 * a state with no valid document representation.
 *
 * Every commit mirrors its `origin` into `message`. Loro exposes `message`
 * but not `origin` to application code through `doc.getAllChanges()`, so the
 * mirror is the only way a consumer can tell a bootstrap commit from a user
 * edit when it walks history.
 */
export function updateLoroToPmState(
  doc: LoroDocType,
  mapping: LoroNodeMapping,
  editorState: EditorState,
  containerId?: ContainerID,
  options?: UpdateLoroOptions,
) {
  const node = editorState.doc;
  const map = getRootContainer(doc, containerId, options?.rootKey);
  const origin = options?.origin ?? LoroOrigins.userEdit;

  if (map.get("nodeName") == null) {
    map.set("nodeName", node.type.name);
    if (origin !== LoroOrigins.sysInit) {
      doc.commit({ origin: LoroOrigins.sysInit, message: LoroOrigins.sysInit });
    }
  }

  updateLoroMap(map, node, mapping);
  doc.commit({ origin, message: origin });
}

/**
 * Convert a LoroText into PM text nodes, one per delta span, carrying the
 * span's attributes as marks.
 *
 * A span whose mark the schema does not know, or whose mark attributes are
 * invalid, is dropped and reported; the rest of the text is kept.
 */
export function loroTextToPmTextNodes(
  schema: Schema,
  obj: LoroText,
  options?: RenderOptions,
): Node[] {
  const nodes: Node[] = [];
  for (const delta of obj.toDelta()) {
    if (delta.insert == null) {
      continue;
    }
    try {
      const marks: Mark[] = [];
      for (const [markName, mark] of Object.entries(delta.attributes ?? {})) {
        const markAttrs = valueToAttrs(mark);
        marks.push(schema.mark(markName, markAttrs ?? undefined));
      }
      nodes.push(schema.text(delta.insert, marks));
    } catch (e) {
      reportViolation(options, obj.id, undefined, e);
    }
  }
  return nodes;
}

export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroNode,
  mapping: LoroNodeMapping,
  options?: RenderOptions,
): Node;
export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroText,
  mapping: LoroNodeMapping,
  options?: RenderOptions,
): Node[];
export function createNodeFromLoroObj(
  schema: Schema,
  obj: LoroNode | LoroText,
  mapping: LoroNodeMapping,
  options?: RenderOptions,
): Node | Node[] | null {
  let retval: Node | Node[] | null = mapping.get(obj.id) ?? null;
  if (retval != null) {
    return retval;
  }

  if (obj instanceof LoroMap) {
    // Read path: never the creating getters. A time-travel checkout detaches
    // the document, where any write -- including getOrCreateContainer's
    // auto-commit -- throws; and a historical frontier can legitimately hold a
    // node whose nested containers were created in a later commit.
    //
    // Missing attributes are an empty attribute set: a root whose attributes
    // are intentionally empty may never have had the container created.
    // Missing children are different -- there is nothing to build the node
    // from -- so the node is dropped (null) and the parent's child filter
    // removes it.
    const attrs = tryGetLoroMapAttributes(obj)?.toJSON() ?? {};
    const children = tryGetLoroMapChildren(obj);
    if (children === undefined) {
      return null;
    }

    const nodeName = obj.get("nodeName");
    if (nodeName == null || typeof nodeName !== "string") {
      throw new Error("Invalid nodeName");
    }

    const mappedChildren = children
      .toArray()
      .flatMap((child) =>
        createNodeFromLoroObj(schema, child as any, mapping, options),
      )
      .filter((n) => n !== null);

    try {
      retval = schema.node(nodeName, attrs, mappedChildren);
      WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
    } catch (e) {
      // The merged content is not a sentence in the schema's grammar, which a
      // concurrent edit can produce. Report it and mark the container so the
      // write-back path leaves it alone.
      reportViolation(options, obj.id, nodeName, e);
      mapping.set(obj.id, UNRENDERABLE);
      return null;
    }
  } else if (obj instanceof LoroText) {
    retval = loroTextToPmTextNodes(schema, obj, options);
  } else {
    /* v8 ignore next */
    throw new Error("Invalid LoroType");
  }

  if (retval != null) {
    if (!Array.isArray(retval)) {
      WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
    }
    mapping.set(obj.id, retval);
  } else {
    mapping.delete(obj.id);
  }

  return retval;
}

export function createLoroChild(
  parentList: LoroChildrenListType,
  pos: number | null,
  nodeOrNodeList: Node | Node[],
  mapping: LoroNodeMapping,
): LoroText | LoroMap {
  return Array.isArray(nodeOrNodeList)
    ? createLoroText(parentList, pos, nodeOrNodeList, mapping)
    : createLoroMap(parentList, pos, nodeOrNodeList, mapping);
}

export function createLoroText(
  parentList: LoroList,
  pos: number | null,
  nodes: Node[],
  mapping: LoroNodeMapping,
): LoroText {
  const obj = parentList
    .insertContainer(pos ?? parentList.length, new LoroText())
    .getAttached()!;

  const delta: Delta<string>[] = nodes.map((node) => ({
    insert: node.text!,
    attributes: nodeMarksToAttributes(node.marks),
  }));
  obj.applyDelta(delta);

  mapping.set(obj.id, nodes);
  return obj;
}

/** Deep-sort object keys so structurally equal values stringify equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * A mark set as a comparable string: null-valued keys dropped, keys sorted,
 * values canonicalised. Loro returns a mark's attributes in a different key
 * order than ProseMirror wrote them, so a plain stringify would never match.
 */
function normalizeAttributes(attributes: Attrs | null | undefined): string {
  const entries = Object.entries(attributes ?? {})
    .filter(([, v]) => v != null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, canonicalize(v)]);
  return JSON.stringify(entries);
}

/**
 * Collapse a span list to `[text, normalizedAttrs]` pairs, merging neighbours
 * that carry the same attributes. Loro merges adjacent identical-attribute
 * runs in `toDelta()` while ProseMirror keeps one span per text node, so both
 * sides must be merged before they can be compared.
 */
function mergeSpans(
  spans: { insert?: string; attributes?: Attrs | null }[],
): [string, string][] {
  const out: [string, string][] = [];
  for (const span of spans) {
    if (typeof span.insert !== "string" || span.insert.length === 0) continue;
    const attrs = normalizeAttributes(span.attributes);
    const last = out[out.length - 1];
    if (last && last[1] === attrs) {
      last[0] += span.insert;
    } else {
      out.push([span.insert, attrs]);
    }
  }
  return out;
}

function attributeSpansMatch(
  actual: Delta<string>[],
  desired: { insert: string; attributes?: Attrs | null }[],
): boolean {
  const a = mergeSpans(actual);
  const b = mergeSpans(desired);
  if (a.length !== b.length) return false;
  return a.every(([text, attrs], i) => b[i][0] === text && b[i][1] === attrs);
}

export function updateLoroText(
  obj: LoroText,
  nodes: Node[],
  mapping: LoroNodeMapping,
) {
  mapping.set(obj.id, nodes);

  let str = obj.toString();
  const attrs: { [key: string]: Attrs | null } = {};
  for (const delta of obj.toDelta()) {
    for (const key of Object.keys(delta.attributes ?? {})) {
      attrs[key] = null;
    }
  }

  const content = nodes.map((p) => ({
    insert: p.text!,
    attributes: Object.assign({}, attrs, nodeMarksToAttributes(p.marks)),
  }));
  const { insert, remove, index } = simpleDiff(
    str,
    content.map((c) => c.insert).join(""),
  );
  if (remove > 0) {
    obj.delete(index, remove);
  }
  if (insert.length) {
    obj.insert(index, insert);
  }

  // Loro records a style op even when the asserted mark is already in effect,
  // and never consolidates the resulting anchors: they persist in the
  // container state, survive snapshots, and are walked by every styled read.
  // This runs on every keystroke, so re-asserting unconditionally degrades a
  // styled paragraph without bound. Skip when the text already carries exactly
  // the marks that would be asserted; any mismatch takes the full path below.
  if (attributeSpansMatch(obj.toDelta(), content)) {
    return;
  }

  obj.applyDelta(
    content.map((c) => ({
      retain: c.insert.length,
      attributes: c.attributes,
    })),
  );
}

/**
 * Reconcile split-brain LoroTexts: when concurrent typing in the same paragraph
 * creates multiple LoroTexts that map to a single PM text group.
 *
 * Key insight: writing the other peer's content into a LoroText creates CRDT
 * operations that sync back, causing the other peer to also write duplicates,
 * creating an exponential amplification loop. Instead, we diff the combined
 * LoroText content against the PM text and apply ONLY the genuine local changes
 * (new keystrokes) to the appropriate LoroText.
 */
export function reconcileSplitBrainTexts(
  loroTexts: LoroText[],
  pmTextGroup: Node[],
  mapping: LoroNodeMapping,
): void {
  // Delete mapping entries so createNodeFromLoroObj rebuilds each LoroText
  // from its own delta.  Setting all LoroTexts to the merged text group would
  // cause PM rebuilds to return the full merged text for EACH LoroText,
  // doubling/tripling content and triggering exponential CRDT amplification.
  for (const lt of loroTexts) {
    mapping.delete(lt.id);
  }

  const combined = loroTexts.map((lt) => lt.toString()).join("");
  const pmText = pmTextGroup.map((n) => n.text!).join("");

  const { index, remove, insert } = simpleDiff(combined, pmText);
  if (remove === 0 && insert.length === 0) return;

  // Build cumulative offset boundaries: [0, len0, len0+len1, ...]
  const boundaries: number[] = [0];
  for (const lt of loroTexts) {
    boundaries.push(boundaries[boundaries.length - 1] + lt.length);
  }

  // Apply deletion (may span multiple LoroTexts)
  if (remove > 0) {
    let pos = index;
    let remaining = remove;
    for (let i = 0; i < loroTexts.length && remaining > 0; i++) {
      if (pos < boundaries[i + 1]) {
        const localPos = pos - boundaries[i];
        const count = Math.min(remaining, loroTexts[i].length - localPos);
        if (count > 0) {
          loroTexts[i].delete(localPos, count);
          remaining -= count;
          for (let j = i + 1; j <= loroTexts.length; j++) {
            boundaries[j] -= count;
          }
        }
        pos = boundaries[i + 1];
      }
    }
  }

  // Apply insertion to the LoroText that contains the target position
  if (insert.length > 0) {
    for (let i = 0; i < loroTexts.length; i++) {
      if (index <= boundaries[i + 1] || i === loroTexts.length - 1) {
        const localPos = Math.min(index - boundaries[i], loroTexts[i].length);
        loroTexts[i].insert(localPos, insert);
        break;
      }
    }
  }
}

export function nodeMarksToAttributes(marks: readonly Mark[]): {
  [key: string]: Attrs;
} {
  const pattrs: { [key: string]: Attrs } = {};
  for (const mark of marks) {
    pattrs[mark.type.name] = mark.attrs;
  }
  return pattrs;
}

function valueToAttrs(value: Value | Attrs | null | undefined): Attrs | null {
  if (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    return value as Attrs;
  }
  return null;
}

function eqLoroTextNodes(obj: LoroText, nodes: Node[]) {
  const delta = obj.toDelta();
  return (
    delta.length === nodes.length &&
    delta.every(
      (delta, i) =>
        delta.insert === nodes[i].text &&
        Object.keys(delta.attributes || {}).length === nodes[i].marks.length &&
        nodes[i].marks.every((mark) => {
          const attrs = valueToAttrs((delta.attributes || {})[mark.type.name]);
          return attrs != null && eqAttrs(attrs, mark.attrs);
        }),
    )
  );
}

// TODO: extract code about equality into a single file
/**
 * Whether the loro object is equal to the node.
 */
function eqLoroObjNode(obj: LoroType, node: Node | Node[]): boolean {
  if (obj instanceof LoroMap) {
    if (Array.isArray(node) || !eqNodeName(obj, node)) {
      return false;
    }

    const loroChildren = getLoroMapChildren(obj);
    const normalizedContent = normalizeNodeContent(node);
    return (
      loroChildren.length === normalizedContent.length &&
      eqAttrs(getLoroMapAttributes(obj).toJSON(), node.attrs) &&
      normalizedContent.every((childNode, i) =>
        eqLoroObjNode(loroChildren.get(i)!, childNode),
      )
    );
  }

  return (
    obj instanceof LoroText && Array.isArray(node) && eqLoroTextNodes(obj, node)
  );
}

function eqAttrs(attrs1: Attrs, attrs2: Attrs) {
  const keys = Object.keys(attrs1).filter((key) => attrs1[key] !== null);
  let eq =
    keys.length ===
    Object.keys(attrs2).filter((key) => attrs2[key] !== null).length;
  for (let i = 0; eq && i < keys.length; i++) {
    const key = keys[i];
    const l = attrs1[key];
    const r = attrs2[key];
    eq =
      l === r ||
      (typeof l === "object" &&
        l !== null &&
        typeof r === "object" &&
        r !== null &&
        eqAttrs(l, r));
  }
  return eq;
}

function eqNodeName(obj: LoroMap, node: Node | Node[]): boolean {
  return !Array.isArray(node) && obj.get("nodeName") === node.type.name;
}

/**
 * Checks if two nodes (or arrays of nodes) are equal.
 * - If both are the same object, returns true.
 * - If both are single nodes, uses their .eq() method.
 * - If both are arrays, checks that they have the same length and each corresponding node is equal.
 */
function eqMappedNode(
  mapped: Node | Node[] | undefined,
  node: Node | Node[] | undefined,
): boolean {
  // If both are the same reference, they are equal
  if (mapped === node) {
    return true;
  }

  // If both are single nodes (not arrays), compare using .eq()
  if (!Array.isArray(mapped) && !Array.isArray(node) && node) {
    return mapped?.eq(node) ?? false;
  }

  // If both are arrays, check length and each element
  if (Array.isArray(mapped) && Array.isArray(node)) {
    if (mapped.length !== node.length) {
      return false;
    }
    for (let i = 0; i < mapped.length; i++) {
      if (!node[i].eq(mapped[i])) {
        return false;
      }
    }
    return true;
  }

  // Otherwise, not equal
  return false;
}

export function normalizeNodeContent(node: Node): (Node | Node[])[] {
  const res: (Node | Node[])[] = [];
  let textNodes: Node[] | null = null;

  node.content.forEach((node, _offset, _i) => {
    if (node.isText) {
      if (textNodes == null) {
        textNodes = [];
        res.push(textNodes);
      }
      textNodes.push(node);
    } else {
      res.push(node);
      textNodes = null;
    }
  });

  return res;
}

function computeChildEqualityFactor(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
): {
  factor: number;
  foundMappedChild: boolean;
} {
  const loroChildren = getLoroMapChildren(obj);
  const loroChildLength = loroChildren.length;

  const nodeChildren = normalizeNodeContent(node);
  const nodeChildLength = nodeChildren.length;

  const minLength = Math.min(loroChildLength, nodeChildLength);
  let left = 0;
  let right = 0;

  let foundMappedChild = false;
  for (; left < minLength; left++) {
    const leftLoro = loroChildren.get(left);
    const leftNode = nodeChildren[left];
    if (
      eqMappedNode(
        leftLoro != null && isContainer(leftLoro)
          ? mapping.get(leftLoro.id)
          : undefined,
        leftNode,
      )
    ) {
      foundMappedChild = true; // good match!
    } else if (
      leftLoro == null ||
      leftNode == null ||
      !eqLoroObjNode(leftLoro, leftNode)
    ) {
      break;
    }
  }
  for (; left + right < minLength; right++) {
    const rightLoro = loroChildren.get(loroChildLength - right - 1);
    const rightNode = nodeChildren[nodeChildLength - right - 1];
    if (
      eqMappedNode(
        rightLoro != null && isContainer(rightLoro)
          ? mapping.get(rightLoro.id)
          : undefined,
        rightNode,
      )
    ) {
      foundMappedChild = true; // good match!
    } else if (
      rightLoro == null ||
      rightNode == null ||
      !eqLoroObjNode(rightLoro, rightNode)
    ) {
      break;
    }
  }
  return {
    factor: left + right,
    foundMappedChild,
  };
}

export function createLoroMap(
  parentList: LoroChildrenListType,
  pos: number | null,
  node: Node,
  mapping: LoroNodeMapping,
): LoroMap {
  const obj = parentList
    .insertContainer(pos ?? parentList.length, new LoroMap())
    .getAttached()! as LoroNode;

  obj.set("nodeName", node.type.name);

  const attrs = getLoroMapAttributes(obj);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value !== null) {
      attrs.set(key, value);
    }
  }

  const children = getLoroMapChildren(obj);
  normalizeNodeContent(node).forEach((child, _i) =>
    createLoroChild(children, null, child, mapping),
  );

  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);
  mapping.set(obj.id, node);
  return obj;
}

export function updateLoroMap(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
) {
  mapping.set(obj.id, node);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);

  if (!eqNodeName(obj, node)) {
    throw new Error("node name mismatch!");
  }

  updateLoroMapAttributes(obj, node, mapping);
  updateLoroMapChildren(obj, node, mapping);
}

/**
 * Read the attributes container of a node without creating it.
 *
 * Returns undefined both when the container is absent (legitimate: a
 * historical frontier predating the key, or intentionally empty attributes)
 * and when the key holds something that is not a LoroMap (a malformed
 * document or version skew, which is warned about). Use on read paths that
 * must not write, such as walking a detached document.
 */
export function tryGetLoroMapAttributes(
  obj: LoroMap,
): LoroMap<{ [key: string]: string }> | undefined {
  const existing = obj.get(ATTRIBUTES_KEY);
  if (existing == null) {
    return undefined;
  }
  if (!(existing instanceof LoroMap)) {
    console.warn(
      `[loro-prosemirror] tryGetLoroMapAttributes: "${ATTRIBUTES_KEY}" on container ${obj.id} does not hold a LoroMap — malformed doc or version skew`,
      existing,
    );
    return undefined;
  }
  return existing as LoroMap<{ [key: string]: string }>;
}

/** The attributes container of a node, created if absent. */
export function getLoroMapAttributes(
  obj: LoroMap,
): LoroMap<{ [key: string]: string }> {
  return (
    tryGetLoroMapAttributes(obj) ??
    obj.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap())
  );
}

export function updateLoroMapAttributes(
  obj: LoroMap,
  node: Node,
  _mapping: LoroNodeMapping,
): void {
  const attrs = getLoroMapAttributes(obj);
  const keys = new Set(attrs.keys());

  const pAttrs = node.attrs;
  for (const [key, value] of Object.entries(pAttrs)) {
    if (value !== null) {
      if (!equalityDeep(attrs.get(key), value)) {
        attrs.set(key, value);
      }
    } else {
      attrs.delete(key);
    }
    keys.delete(key);
  }

  // remove all keys that are no longer in pAttrs
  for (const key of keys) {
    attrs.delete(key);
  }
}

/**
 * Read the children container of a node without creating it. Same contract
 * as {@link tryGetLoroMapAttributes}: undefined for absent or malformed.
 */
export function tryGetLoroMapChildren(
  obj: LoroNode,
): LoroChildrenListType | undefined {
  const existing = obj.get(CHILDREN_KEY);
  if (existing == null) {
    return undefined;
  }
  if (!(existing instanceof LoroList)) {
    console.warn(
      `[loro-prosemirror] tryGetLoroMapChildren: "${CHILDREN_KEY}" on container ${obj.id} does not hold a LoroList — malformed doc or version skew`,
      existing,
    );
    return undefined;
  }
  return existing as LoroChildrenListType;
}

/** The children container of a node, created if absent. */
export function getLoroMapChildren(obj: LoroNode): LoroChildrenListType {
  return (
    tryGetLoroMapChildren(obj) ??
    obj.getOrCreateContainer(CHILDREN_KEY, new LoroList())
  );
}

export function updateLoroMapChildren(
  obj: LoroNode,
  node: Node,
  mapping: LoroNodeMapping,
): void {
  const loroChildren = getLoroMapChildren(obj);
  const loroChildLength = loroChildren.length;

  const nodeChildren = normalizeNodeContent(node);
  const nodeChildLength = nodeChildren.length;

  const minLength = Math.min(nodeChildLength, loroChildLength);
  let left = 0;
  let right = 0;

  // find number of matching elements from left
  for (; left < minLength; left++) {
    const leftLoro = loroChildren.get(left);
    const leftNode = nodeChildren[left];
    if (leftLoro == null || leftNode == null) {
      break;
    }

    if (isContainer(leftLoro) && mapping.get(leftLoro.id) !== leftNode) {
      if (
        eqMappedNode(mapping.get(leftLoro.id), leftNode) ||
        eqLoroObjNode(leftLoro, leftNode)
      ) {
        // We need to refresh all the mappings under this node
        if (!Array.isArray(leftNode)) {
          updateLoroMap(leftLoro as LoroNode, leftNode as Node, mapping);
        }
      } else {
        break;
      }
    }
  }

  // find number of matching elements from right
  for (; right + left < minLength; right++) {
    const rightLoro = loroChildren.get(loroChildLength - right - 1);
    const rightNode = nodeChildren[nodeChildLength - right - 1];
    if (rightLoro == null || rightNode == null) {
      break;
    }

    if (isContainer(rightLoro) && mapping.get(rightLoro.id) !== rightNode) {
      if (
        eqMappedNode(mapping.get(rightLoro.id), rightNode) ||
        eqLoroObjNode(rightLoro, rightNode)
      ) {
        // We need to refresh all the mappings under this node
        if (!Array.isArray(rightNode)) {
          updateLoroMap(rightLoro as LoroNode, rightNode as Node, mapping);
        }
      } else {
        break;
      }
    }
  }

  // Try to compare and update the mismatched middle region.
  // Use separate Loro/PM indices because split-brain LoroTexts (concurrent
  // typing creates multiple LoroTexts for one PM text group) break the 1:1
  // child alignment the original shared-index loop assumed.
  let loroLeft = left;
  let pmLeft = left;
  // These shrink as the `updateRight` branch consumes children from the right.
  // They must not be captured as consts: that branch advances neither index,
  // so a frozen bound makes the loop non-terminating.
  let loroMidEnd = loroChildLength - right;
  let pmMidEnd = nodeChildLength - right;

  while (loroLeft < loroMidEnd && pmLeft < pmMidEnd) {
    const leftLoro = loroChildren.get(loroLeft);
    const leftNode = nodeChildren[pmLeft];

    // A container that could not be rendered has no ProseMirror counterpart to
    // align against. Step over it without consuming a ProseMirror child.
    if (isContainer(leftLoro) && isUnrenderable(mapping, leftLoro.id)) {
      loroLeft += 1;
      continue;
    }

    if (leftLoro instanceof LoroText && Array.isArray(leftNode)) {
      // Count consecutive LoroTexts (split-brain detection)
      let splitCount = 1;
      while (
        loroLeft + splitCount < loroMidEnd &&
        loroChildren.get(loroLeft + splitCount) instanceof LoroText
      ) {
        splitCount++;
      }

      if (splitCount === 1) {
        // Normal: single LoroText
        if (!eqLoroTextNodes(leftLoro, leftNode)) {
          updateLoroText(leftLoro, leftNode, mapping);
        }
      } else {
        // Split-brain: multiple concurrent LoroTexts for one PM text group.
        // Only write genuine local diffs to prevent CRDT amplification.
        const loroTexts: LoroText[] = [];
        for (let i = 0; i < splitCount; i++) {
          loroTexts.push(loroChildren.get(loroLeft + i) as LoroText);
        }
        reconcileSplitBrainTexts(loroTexts, leftNode, mapping);
      }

      loroLeft += splitCount;
      pmLeft += 1;
    } else {
      const rightLoro = loroChildren.get(loroMidEnd - 1);
      const rightNode = nodeChildren[pmMidEnd - 1];

      let updateLeft =
        leftLoro instanceof LoroMap && eqNodeName(leftLoro, leftNode);
      let updateRight =
        rightLoro instanceof LoroMap && eqNodeName(rightLoro, rightNode);

      if (updateLeft && updateRight) {
        // decide which which element to update
        const leftEquality = computeChildEqualityFactor(
          leftLoro as LoroNode,
          leftNode as Node,
          mapping,
        );
        const rightEquality = computeChildEqualityFactor(
          rightLoro as LoroNode,
          rightNode as Node,
          mapping,
        );

        if (leftEquality.foundMappedChild && !rightEquality.foundMappedChild) {
          updateRight = false;
        } else if (
          rightEquality.foundMappedChild &&
          !leftEquality.foundMappedChild
        ) {
          updateLeft = false;
        } else if (leftEquality.factor < rightEquality.factor) {
          updateLeft = false;
        } else {
          updateRight = false;
        }
      }

      if (updateLeft) {
        updateLoroMap(leftLoro as LoroNode, leftNode as Node, mapping);
        loroLeft += 1;
        pmLeft += 1;
      } else if (updateRight) {
        updateLoroMap(rightLoro as LoroNode, rightNode as Node, mapping);
        right += 1;
        loroMidEnd -= 1;
        pmMidEnd -= 1;
      } else {
        // recreate the element at loroLeft
        const child = loroChildren.get(loroLeft);
        if (isContainer(child)) {
          mapping.delete(child.id);
        }
        loroChildren.delete(loroLeft, 1);
        createLoroChild(loroChildren, loroLeft, leftNode, mapping);
        loroLeft += 1;
        pmLeft += 1;
      }
    }
  }

  const loroSurplus = loroChildLength - right - loroLeft;
  if (
    loroChildLength === 1 &&
    nodeChildLength === 0 &&
    loroChildren.get(0) instanceof LoroText
  ) {
    // Only delete the content of the LoroText to retain remote changes on the same LoroText object
    // Otherwise, the LoroText object will be deleted and all the concurrent edits to the same LoroText object will be lost
    const loroText = loroChildren.get(0) as LoroText;
    mapping.delete(loroText.id);
    loroText.delete(0, loroText.length);
  } else if (loroSurplus > 0) {
    const surplus = loroChildren
      .toArray()
      .slice(loroLeft, loroLeft + loroSurplus);

    // Walk backwards so the indices of earlier entries stay valid as we delete.
    for (let i = surplus.length - 1; i >= 0; i--) {
      const child = surplus[i];
      if (isContainer(child)) {
        // Content we merely failed to render is not content anyone deleted.
        // Leave it in the CRDT so it survives until the conflict resolves;
        // deleting it here would destroy it for every peer, permanently.
        if (isUnrenderable(mapping, child.id)) {
          continue;
        }
        mapping.delete(child.id);
      }
      loroChildren.delete(loroLeft + i, 1);
    }
  }

  if (pmLeft < nodeChildLength - right) {
    nodeChildren
      .slice(pmLeft, nodeChildLength - right)
      .forEach((nodeChild, i) =>
        createLoroChild(loroChildren, loroLeft + i, nodeChild, mapping),
      );
  }
}

export function clearChangedNodes(
  doc: LoroDocType,
  event: LoroEventBatch,
  mapping: LoroNodeMapping,
) {
  for (const e of event.events) {
    const obj = doc.getContainerById(e.target);
    mapping.delete(obj!.id);

    let parentObj = obj!.parent();
    while (parentObj) {
      mapping.delete(parentObj!.id);
      parentObj = parentObj!.parent();
    }
  }
}

/**
 * Set a text selection between the given anchor and head positions. This
 * function will ignore out-of-bounds positions, and find a valid selection near
 * the given positions.
 */
export function safeSetSelection(
  view: EditorView,
  anchor: number,
  head?: number,
): void {
  const doc = view.state.doc;
  const docSize = doc.content.size;
  if (
    anchor < 0 ||
    anchor > docSize ||
    (head != null && (head < 0 || head > docSize))
  ) {
    return;
  }

  const $anchor = doc.resolve(anchor);
  const $head = head != null ? doc.resolve(head) : undefined;

  const selection = TextSelection.between($anchor, $head || $anchor);
  view.dispatch(view.state.tr.setSelection(selection));
}

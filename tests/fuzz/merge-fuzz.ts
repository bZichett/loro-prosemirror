/**
 * Property-based fuzzing for concurrent merges.
 *
 * Every bug found by hand in this area lived in the same place: the region
 * where the ProseMirror tree and the Loro tree disagree structurally. Hand
 * written scenarios reach that region only by luck. This generates the
 * divergence instead.
 *
 * Everything is a pure function of a seed and a list of `Op`s, so a failure
 * replays exactly and can be shrunk to a minimal counterexample.
 */
import { type ContainerID, LoroDoc, LoroList, LoroMap } from "loro-crdt";
import type { Node as PmNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  createNodeFromLoroObj,
  getLoroMapChildren,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  type SchemaViolationInfo,
  updateLoroToPmState,
} from "../../src/lib";
import { schema } from "../schema";

// --------------------------------------------------------------- randomness

/** mulberry32: small, fast, and reproducible across runs and machines. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];
const int = (r: () => number, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));

// -------------------------------------------------------- document shapes

const WORDS = ["alpha", "beta", "gamma", "delta", "eps", "zeta"];

function text(r: () => number) {
  return pick(r, WORDS) + (r() < 0.3 ? String(int(r, 0, 9)) : "");
}

function inlineRun(r: () => number, max: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0, n = int(r, 0, max); i < n; i++) {
    const marks: unknown[] = [];
    if (r() < 0.25) marks.push({ type: "bold" });
    if (r() < 0.15) marks.push({ type: "italic" });
    out.push({
      type: "text",
      text: text(r),
      ...(marks.length ? { marks } : {}),
    });
  }
  return out;
}

function block(r: () => number, depth: number): unknown {
  const kinds =
    depth > 0
      ? (["paragraph", "noteTitle", "bulletList"] as const)
      : (["paragraph"] as const);
  switch (pick(r, kinds)) {
    case "noteTitle":
      return { type: "noteTitle", content: inlineRun(r, 2) };
    case "bulletList":
      return {
        type: "bulletList",
        content: Array.from({ length: int(r, 1, 3) }, () => ({
          type: "listItem",
          content: [
            { type: "paragraph", content: inlineRun(r, 2) },
            ...(r() < 0.25 ? [block(r, depth - 1)] : []),
          ],
        })),
      };
    default:
      return { type: "paragraph", content: inlineRun(r, 3) };
  }
}

export function randomDoc(r: () => number): unknown {
  return {
    type: "doc",
    content: Array.from({ length: int(r, 1, 4) }, () => block(r, 1)),
  };
}

// ------------------------------------------------------------------- ops

/**
 * Positions are stored as fractions of the document size and resolved at
 * execution time. That keeps every op applicable no matter which other ops
 * the shrinker removed, so shrinking can never manufacture a bogus failure.
 */
export type Op =
  | { kind: "insertText"; peer: 0 | 1; at: number; text: string }
  | { kind: "delete"; peer: 0 | 1; at: number; len: number }
  | {
      kind: "mark";
      peer: 0 | 1;
      at: number;
      len: number;
      mark: "bold" | "italic";
    }
  | { kind: "insertBlock"; peer: 0 | 1; at: number; node: unknown }
  | { kind: "violate"; peer: 0 | 1; nth: number };

export function generateOps(
  r: () => number,
  count: number,
  adversarial: boolean,
): Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const peer = (r() < 0.5 ? 0 : 1) as 0 | 1;
    const roll = r();
    if (adversarial && roll < 0.2) {
      ops.push({ kind: "violate", peer, nth: int(r, 0, 5) });
    } else if (roll < 0.4) {
      ops.push({ kind: "insertText", peer, at: r(), text: text(r) });
    } else if (roll < 0.6) {
      ops.push({ kind: "delete", peer, at: r(), len: int(r, 1, 8) });
    } else if (roll < 0.8) {
      ops.push({
        kind: "mark",
        peer,
        at: r(),
        len: int(r, 1, 6),
        mark: r() < 0.5 ? "bold" : "italic",
      });
    } else {
      ops.push({ kind: "insertBlock", peer, at: r(), node: block(r, 0) });
    }
  }
  return ops;
}

// ------------------------------------------------------------- execution

interface Peer {
  doc: LoroDocType;
  state: EditorState;
  mapping: LoroNodeMapping;
  violations: SchemaViolationInfo[];
}

const frac = (at: number, size: number) =>
  Math.max(0, Math.min(size, Math.floor(at * size)));

/** Apply an op to a peer. Ops that land somewhere illegal are skipped. */
function applyOp(p: Peer, op: Op) {
  if (op.kind === "violate") {
    violate(p.doc, op.nth);
    return;
  }
  const doc = p.state.doc;
  const size = doc.content.size;
  const pos = frac(op.at, size);
  try {
    let tr = p.state.tr;
    switch (op.kind) {
      case "insertText":
        tr = tr.insertText(op.text, Math.max(1, Math.min(pos, size - 1)));
        break;
      case "delete":
        tr = tr.delete(pos, Math.min(size, pos + op.len));
        break;
      case "mark":
        tr = tr.addMark(
          pos,
          Math.min(size, pos + op.len),
          schema.marks[op.mark].create(),
        );
        break;
      case "insertBlock":
        tr = tr.insert(pos, schema.nodeFromJSON(op.node));
        break;
    }
    p.state = p.state.apply(tr);
  } catch {
    return; // the generator proposed an edit ProseMirror will not make
  }
}

/** Collect every node container in the document, depth first. */
function allNodes(doc: LoroDocType): LoroNode[] {
  const out: LoroNode[] = [];
  const walk = (n: LoroNode) => {
    out.push(n);
    for (const child of getLoroMapChildren(n).toArray()) {
      if (child instanceof LoroMap) walk(child as LoroNode);
    }
  };
  walk(doc.getMap(ROOT_DOC_KEY) as LoroNode);
  return out;
}

/**
 * Write a term the CRDT accepts but the grammar rejects: a block child inside
 * a node whose content expression admits only inline content. Stands in for
 * any peer writing the document without this binding's schema.
 */
function violate(doc: LoroDocType, nth: number) {
  const targets = allNodes(doc).filter((n) => {
    const name = n.get("nodeName");
    return name === "noteTitle" || name === "paragraph";
  });
  if (!targets.length) return;
  const kids = getLoroMapChildren(targets[nth % targets.length]);
  const bad = kids.insertContainer(kids.length, new LoroMap()) as LoroMap<
    Record<string, unknown>
  >;
  bad.set("nodeName", "paragraph");
  bad.setContainer("children", new LoroList());
  bad.setContainer("attributes", new LoroMap());
  doc.commit();
}

function render(p: Peer): PmNode | null {
  return createNodeFromLoroObj(
    schema,
    p.doc.getMap(ROOT_DOC_KEY) as LoroNode,
    p.mapping,
    { onSchemaViolation: (v) => p.violations.push(v) },
  );
}

/** Multiset of node names, as a sorted list -- the document's shape. */
function shape(doc: LoroDocType): string[] {
  return allNodes(doc)
    .map((n) => String(n.get("nodeName")))
    .sort();
}

/**
 * A caret position inside the first text block, so an inserted character needs
 * no wrapper nodes to hold it. Inserting at an arbitrary position would make
 * ProseMirror build a paragraph (or a list item) around the text, which is
 * correct behaviour and not the deletion this property is looking for.
 */
function firstTextPosition(doc: PmNode): number | null {
  let found: number | null = null;
  doc.descendants((n, pos) => {
    if (found != null) return false;
    if (n.isTextblock) {
      found = pos + 1;
      return false;
    }
    return true;
  });
  return found;
}

const sync = (from: LoroDocType, to: LoroDocType) =>
  to.import(from.export({ mode: "update" }));

export interface Failure {
  property: string;
  detail: string;
}

/**
 * Fork two peers from `docJson`, apply `ops` to each in isolation, merge, then
 * check the properties that must hold no matter what the peers did.
 */
export function runScenario(docJson: unknown, ops: Op[]): Failure | null {
  const seedState = EditorState.create({
    doc: schema.nodeFromJSON(docJson),
    schema,
  });

  const base: LoroDocType = new LoroDoc();
  updateLoroToPmState(base, new Map(), seedState);
  base.commit();

  const peers: Peer[] = [0, 1].map(() => {
    const doc: LoroDocType = new LoroDoc();
    sync(base, doc);
    const mapping: LoroNodeMapping = new Map();
    const node = createNodeFromLoroObj(
      schema,
      doc.getMap(ROOT_DOC_KEY) as LoroNode,
      mapping,
    );
    return {
      doc,
      mapping,
      violations: [],
      state: EditorState.create({ doc: node, schema }),
    };
  });

  // Each peer edits offline.
  for (const op of ops) {
    const p = peers[op.peer];
    applyOp(p, op);
    if (op.kind !== "violate") {
      updateLoroToPmState(p.doc, p.mapping, p.state);
    }
  }

  // Merge, both directions, to a fixed point.
  sync(peers[0].doc, peers[1].doc);
  sync(peers[1].doc, peers[0].doc);

  const [a, b] = peers;

  // An import invalidates the mapping: the plugin calls `clearChangedNodes`
  // before re-rendering. Mirror that here with a fresh mapping, otherwise
  // `createNodeFromLoroObj` returns stale nodes for changed containers and we
  // would be testing our own misuse rather than the binding.
  a.mapping = new Map();
  b.mapping = new Map();

  if (JSON.stringify(a.doc.toJSON()) !== JSON.stringify(b.doc.toJSON())) {
    return {
      property: "convergence",
      detail: "peers hold different documents after a full exchange",
    };
  }

  // Both peers must be able to derive *some* document without throwing.
  let nodeA: PmNode | null;
  try {
    nodeA = render(a);
    render(b);
  } catch (e) {
    return { property: "renders", detail: `rendering threw: ${String(e)}` };
  }
  if (nodeA == null) {
    return { property: "renders", detail: "rendered to nothing" };
  }

  // Writing back an unchanged view must not touch the document. If it does,
  // every keystroke amplifies the history and peers can never settle.
  const beforeIdem = JSON.stringify(a.doc.toJSON());
  updateLoroToPmState(
    a.doc,
    a.mapping,
    EditorState.create({ doc: nodeA, schema }),
  );
  if (JSON.stringify(a.doc.toJSON()) !== beforeIdem) {
    return {
      property: "no-amplification",
      detail: "writing back an unchanged document modified it",
    };
  }

  // The property that matters most: an ordinary keystroke must not destroy
  // content. Typing one character inside an existing text block adds and
  // removes no nodes, so the document's shape must come back identical.
  const caret = firstTextPosition(nodeA);
  if (caret != null) {
    const before = shape(a.doc);
    const typing = EditorState.create({ doc: nodeA, schema });
    updateLoroToPmState(
      a.doc,
      a.mapping,
      typing.apply(typing.tr.insertText("!", caret)),
    );
    const after = shape(a.doc);
    if (before.join(",") !== after.join(",")) {
      return {
        property: "conservation",
        detail: `typing one character changed the document shape\n  before: ${before.join(",")}\n  after:  ${after.join(",")}`,
      };
    }
  }

  return null;
}

// ------------------------------------------------------------- campaign

export interface CampaignOptions {
  seed: number;
  iterations: number;
  maxOps: number;
  adversarial: boolean;
  label: string;
}

/** Delta-debugging: drop ops one at a time, keeping any that still fail. */
function shrink(docJson: unknown, ops: Op[]): Op[] {
  let best = ops;
  for (let i = best.length - 1; i >= 0; i--) {
    const candidate = best.filter((_, j) => j !== i);
    if (runScenario(docJson, candidate)) best = candidate;
  }
  return best;
}

export function runCampaign(opts: CampaignOptions): void {
  for (let i = 0; i < opts.iterations; i++) {
    const seed = opts.seed + i;
    const r = rng(seed);
    const docJson = randomDoc(r);
    const ops = generateOps(r, int(r, 1, opts.maxOps), opts.adversarial);

    let failure: Failure | null;
    try {
      failure = runScenario(docJson, ops);
    } catch (e) {
      failure = { property: "crash", detail: String(e) };
    }
    if (!failure) continue;

    const minimal = shrink(docJson, ops);
    throw new Error(
      [
        `${opts.label}: property "${failure.property}" failed`,
        failure.detail,
        `seed: ${seed}`,
        `ops (shrunk ${ops.length} -> ${minimal.length}):`,
        JSON.stringify(minimal, null, 2),
        `document:`,
        JSON.stringify(docJson),
      ].join("\n"),
    );
  }
}

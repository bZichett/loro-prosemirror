/**
 * Re-asserting an IDENTICAL mark set over a styled text must record no new ops.
 *
 * `updateLoroText` runs on every PM -> Loro write-back (i.e. every keystroke)
 * and ends by re-applying the full attribute set across the whole text. Loro
 * never consolidates style anchors, so a redundant mark assertion leaves a pair
 * of anchors in the container state permanently: they survive snapshots and are
 * walked by every styled read.
 */

import { describe, expect, test } from "vitest";
import { LoroDoc, LoroText } from "loro-crdt";

import {
  createLoroText,
  updateLoroText,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { type Node } from "prosemirror-model";

import { schema } from "./schema";

/** Total ops recorded in the oplog. */
function opCount(doc: LoroDocType): number {
  const updates = doc.exportJsonUpdates() as unknown as {
    changes: { ops: unknown[] }[];
  };
  return updates.changes.reduce((n, c) => n + c.ops.length, 0);
}

/** A FRAGMENTED style layout: plain | bold | italic | bold. */
function styledNodes() {
  return [
    schema.text("plain "),
    schema.text("bold", [schema.marks.bold.create()]),
    schema.text(" mid "),
    schema.text("ital", [schema.marks.italic.create()]),
    schema.text(" tail", [schema.marks.bold.create()]),
  ];
}

/**
 * Fragmented layout whose marks carry MULTIPLE attributes. Loro returns a
 * mark's attrs in a different key order than PM wrote them, so only a mark
 * shaped like this exercises the guard's order-independent comparison.
 */
function linkedNodes() {
  const link = schema.marks.link.create({
    href: "https://example.com",
    title: "Example",
    target: "_blank",
    pn: "pl_abc",
  });
  return [
    schema.text("plain "),
    schema.text("link", [link]),
    schema.text(" mid "),
    schema.text("ital", [schema.marks.italic.create()]),
    schema.text(" tail", [link]),
  ];
}

function seed(nodes: () => Node[] = styledNodes) {
  const doc: LoroDocType = new LoroDoc();
  const list = (doc as LoroDoc).getList("root");
  const mapping: LoroNodeMapping = new Map();
  const text = createLoroText(list, null, nodes(), mapping);
  doc.commit();
  return { doc, text, mapping };
}

/**
 * Mark names in effect at the first character of `needle`. Position-based
 * because Loro merges adjacent same-attribute spans, so a span's text is not a
 * stable handle once its marks change.
 */
function marksOf(text: LoroText, needle: string): string[] {
  const at = text.toString().indexOf(needle);
  if (at < 0)
    throw new Error(`text does not contain ${JSON.stringify(needle)}`);

  let offset = 0;
  for (const span of text.toDelta()) {
    if (typeof span.insert !== "string") continue;
    if (at < offset + span.insert.length) {
      return Object.entries(span.attributes ?? {})
        .filter(([, v]) => v != null)
        .map(([k]) => k)
        .sort();
    }
    offset += span.insert.length;
  }
  throw new Error(`no span covers index ${at}`);
}

describe("redundant mark re-assertion", () => {
  test("re-syncing identical marks records no new ops", () => {
    const doc: LoroDocType = new LoroDoc();
    const list = (doc as LoroDoc).getList("root");
    const mapping: LoroNodeMapping = new Map();

    const text = createLoroText(list, null, styledNodes(), mapping);
    doc.commit();

    const baseline = opCount(doc);

    for (let i = 0; i < 50; i++) {
      updateLoroText(text, styledNodes(), mapping);
      doc.commit();
    }

    expect(opCount(doc) - baseline).toBe(0);
  });

  test("re-syncing a multi-attribute mark records no new ops", () => {
    const { doc, text, mapping } = seed(linkedNodes);
    const baseline = opCount(doc);

    for (let i = 0; i < 50; i++) {
      updateLoroText(text, linkedNodes(), mapping);
      doc.commit();
    }

    expect(opCount(doc) - baseline).toBe(0);
  });

  test("adding a mark still applies", () => {
    const { doc, text, mapping } = seed();

    const next = styledNodes();
    next[2] = schema.text(" mid ", [schema.marks.italic.create()]);
    updateLoroText(text, next, mapping);
    doc.commit();

    expect(marksOf(text, " mid ")).toEqual(["italic"]);
  });

  test("removing a mark still applies", () => {
    const { doc, text, mapping } = seed();

    const next = styledNodes();
    next[1] = schema.text("bold");
    updateLoroText(text, next, mapping);
    doc.commit();

    expect(marksOf(text, "bold")).toEqual([]);
  });

  test("typing into a styled span keeps text and marks correct", () => {
    const { doc, text, mapping } = seed();

    const next = styledNodes();
    next[1] = schema.text("boXld", [schema.marks.bold.create()]);
    updateLoroText(text, next, mapping);
    doc.commit();

    expect(text.toString()).toBe("plain boXld mid ital tail");
    expect(marksOf(text, "boXld")).toEqual(["bold"]);
  });
});

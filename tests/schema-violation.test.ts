/**
 * ProseMirror's schema is a regular tree grammar: each node type's permitted
 * children form a regular language, and `schema.node()` rejects anything else.
 * Loro is a join-semilattice: merge is a least upper bound, and it guarantees
 * convergence on *a* term, not on a well-formed one.
 *
 * So the grammar's sublanguage is not closed under merge. Two peers can each
 * hold a valid document whose join is a term the schema rejects. These tests
 * pin down what the binding does when that happens.
 */
import { execFileSync } from "node:child_process";
import { type ContainerID, LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import {
  createNodeFromLoroObj,
  getLoroMapChildren,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  updateLoroToPmState,
} from "../src/lib";
import { schema } from "./schema";

const P = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const TITLE = (text: string) => ({
  type: "noteTitle",
  content: [{ type: "text", text }],
});

function sync(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update" }));
}

function stateOf(json: unknown) {
  return EditorState.create({ doc: schema.nodeFromJSON(json), schema });
}

function seed(doc: LoroDocType, json: unknown): LoroNodeMapping {
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(doc, mapping, stateOf(json));
  doc.commit();
  return mapping;
}

function rootChildren(doc: LoroDocType) {
  return getLoroMapChildren(doc.getMap(ROOT_DOC_KEY) as LoroNode);
}

/**
 * Give a `noteTitle` (`content: "text*"`) a block child, so the document is
 * still a legal CRDT term but no longer a legal ProseMirror one.
 *
 * This stands in for any peer that can write the CRDT without going through
 * this binding's schema -- another client version, a server-side transform, a
 * peer running a newer schema. Loro has no gatekeeper, which is the point.
 */
function violateTitle(doc: LoroDocType, titleIndex: number) {
  const title = rootChildren(doc).get(titleIndex) as LoroNode;
  const kids = getLoroMapChildren(title);
  // The children list is typed as node-maps-or-text; we are deliberately
  // inserting something the ProseMirror schema will refuse to accept.
  const bad = kids.insertContainer(kids.length, new LoroMap()) as LoroMap<
    Record<string, unknown>
  >;
  bad.set("nodeName", "paragraph");
  bad.setContainer("children", new LoroList());
  bad.setContainer("attributes", new LoroMap());
  doc.commit();
}

function nodeNames(doc: LoroDocType): string[] {
  return (doc.toJSON() as any).doc.children.map((c: any) => c.nodeName);
}

describe("schema-violating merges", () => {
  test("a merge can produce a term the schema rejects", () => {
    const peerA: LoroDocType = new LoroDoc();
    seed(peerA, { type: "doc", content: [TITLE("Title"), P("hello")] });
    const peerB: LoroDocType = new LoroDoc();
    sync(peerA, peerB);

    violateTitle(peerB, 0);
    sync(peerB, peerA);

    // The CRDT converged and kept everything.
    expect(nodeNames(peerA)).toEqual(["noteTitle", "paragraph"]);

    // The grammar cannot express it, so the view loses the title. This gap is
    // expected and acceptable; the tests below are about what must NOT happen.
    const rendered = createNodeFromLoroObj(
      schema,
      peerA.getMap(ROOT_DOC_KEY) as LoroNode,
      new Map(),
    )!;
    expect(rendered.toJSON()).toEqual({
      type: "doc",
      content: [P("hello")],
    });
  });

  test.fails(
    "an ordinary local edit must not delete the unrenderable node from the CRDT",
    () => {
      const peerA: LoroDocType = new LoroDoc();
      // The title sits last so this scenario exercises the write-back path only,
      // without tripping the separate non-termination bug covered below.
      seed(peerA, { type: "doc", content: [P("hello"), TITLE("Title")] });
      const peerB: LoroDocType = new LoroDoc();
      sync(peerA, peerB);

      violateTitle(peerB, 1);
      sync(peerB, peerA);

      const mapping: LoroNodeMapping = new Map();
      const rendered = createNodeFromLoroObj(
        schema,
        peerA.getMap(ROOT_DOC_KEY) as LoroNode,
        mapping,
      )!;
      expect(rendered.childCount).toBe(1); // title dropped from the view

      // Peer A types a single character into the surviving paragraph.
      const state = EditorState.create({ doc: rendered, schema });
      const next = state.apply(
        state.tr.insertText("!", rendered.content.size - 1),
      );
      updateLoroToPmState(peerA, mapping, next);

      expect(next.doc.textContent).toBe("hello!");
      // The title was never edited by anyone. It must survive.
      expect(nodeNames(peerA)).toContain("noteTitle");
    },
  );

  test.fails(
    "the deletion must not propagate to the peer that still renders it",
    () => {
      const peerA: LoroDocType = new LoroDoc();
      seed(peerA, { type: "doc", content: [P("hello"), TITLE("Title")] });
      const peerB: LoroDocType = new LoroDoc();
      sync(peerA, peerB);

      violateTitle(peerB, 1);
      sync(peerB, peerA);

      const mapping: LoroNodeMapping = new Map();
      const rendered = createNodeFromLoroObj(
        schema,
        peerA.getMap(ROOT_DOC_KEY) as LoroNode,
        mapping,
      )!;
      const state = EditorState.create({ doc: rendered, schema });
      updateLoroToPmState(
        peerA,
        mapping,
        state.apply(state.tr.insertText("!", rendered.content.size - 1)),
      );

      sync(peerA, peerB);

      // Peer B authored the title's extra child and can still see the title's
      // text. Peer A's unrelated keystroke must not destroy it for peer B.
      expect(nodeNames(peerB)).toContain("noteTitle");
    },
  );

  test.fails(
    "updateLoroMapChildren terminates on structural divergence",
    () => {
      // Run in a child process: the failure mode is a synchronous infinite loop,
      // which vitest's testTimeout cannot interrupt.
      execFileSync(
        "npx",
        ["vitest", "run", "tests/hang-repro.test.ts", "--reporter=basic"],
        {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, RUN_HANG_REPRO: "1", CI: "1" },
          timeout: 60_000,
          stdio: "pipe",
        },
      );
    },
    90_000,
  );

  test.fails(
    "schema violations are reported, not just logged to the console",
    () => {
      const peerA: LoroDocType = new LoroDoc();
      seed(peerA, { type: "doc", content: [P("hello"), TITLE("Title")] });
      const peerB: LoroDocType = new LoroDoc();
      sync(peerA, peerB);
      violateTitle(peerB, 1);
      sync(peerB, peerA);

      // The contract this pins down: callers can observe which containers the
      // schema rejected, rather than discovering it in a console.error.
      const seen: { containerId: ContainerID; nodeName?: string }[] = [];
      const unrenderable = new Set<ContainerID>();
      const render = createNodeFromLoroObj as unknown as (
        s: typeof schema,
        o: LoroNode,
        m: LoroNodeMapping,
        opts?: {
          onSchemaViolation?: (i: {
            containerId: ContainerID;
            nodeName?: string;
          }) => void;
          unrenderable?: Set<ContainerID>;
        },
      ) => unknown;

      render(schema, peerA.getMap(ROOT_DOC_KEY) as LoroNode, new Map(), {
        onSchemaViolation: (i) => seen.push(i),
        unrenderable,
      });

      expect(seen.map((s) => s.nodeName)).toEqual(["noteTitle"]);
      expect(unrenderable.size).toBe(1);
    },
  );
});

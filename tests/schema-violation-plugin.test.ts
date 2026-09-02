/** @vitest-environment jsdom */
/**
 * End-to-end cover for a schema-violating merge arriving through the real
 * sync plugin, rather than through the lower-level lib functions.
 */
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { afterEach, describe, expect, test } from "vitest";
import {
  getLoroMapChildren,
  type LoroDocType,
  type LoroNode,
  type SchemaViolationInfo,
  ROOT_DOC_KEY,
  updateLoroToPmState,
} from "../src/lib";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { schema } from "./schema";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

const DOC = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "hello" }] },
    { type: "noteTitle", content: [{ type: "text", text: "Title" }] },
  ],
};

function seed(doc: LoroDocType) {
  updateLoroToPmState(
    doc,
    new Map(),
    EditorState.create({ doc: schema.nodeFromJSON(DOC), schema }),
  );
  doc.commit();
}

/** Give the `noteTitle` (`content: "text*"`) a block child. */
function violateTitle(doc: LoroDocType) {
  const kids = getLoroMapChildren(
    getLoroMapChildren(doc.getMap(ROOT_DOC_KEY) as LoroNode).get(1) as LoroNode,
  );
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

describe("LoroSyncPlugin on a schema-violating merge", () => {
  test("reports the violation and keeps typing non-destructive", async () => {
    const violations: SchemaViolationInfo[] = [];

    const local: LoroDocType = new LoroDoc();
    seed(local);
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({
        schema,
        plugins: [
          LoroSyncPlugin({
            doc: local,
            onSchemaViolation: (info) => violations.push(info),
          }),
        ],
      }),
    });
    views.push(view);
    await flush();
    expect(view.state.doc.childCount).toBe(2);

    // A remote peer produces content this schema cannot express.
    const remote: LoroDocType = new LoroDoc();
    remote.import(local.export({ mode: "update" }));
    violateTitle(remote);
    local.import(remote.export({ mode: "update" }));
    await flush();

    // The application is told, instead of having to watch console.error.
    expect(violations.map((v) => v.nodeName)).toEqual(["noteTitle"]);

    // The title cannot be rendered, so the view drops it.
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.textContent).toBe("hello");

    // Typing must not turn that display gap into a permanent deletion.
    view.dispatch(view.state.tr.insertText("!", 1));
    await flush();

    expect(view.state.doc.textContent).toBe("!hello");
    expect(nodeNames(local)).toContain("noteTitle");

    // ...and the peer that can still make sense of it keeps it too.
    remote.import(local.export({ mode: "update" }));
    expect(nodeNames(remote)).toContain("noteTitle");
  });
});

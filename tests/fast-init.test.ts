/**
 * @vitest-environment jsdom
 *
 * `fastInit`: when the editor already holds a document structurally identical
 * to the Loro document, init builds the container mapping by walking both in
 * parallel instead of replacing the document. Observable as the document
 * instance surviving init -- a transaction with no steps keeps `state.doc` --
 * which is exactly what keeps plugin decorations alive.
 */

import { afterEach, describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const CONTENT = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "hello" }] },
    { type: "paragraph", content: [{ type: "text", text: "world" }] },
  ],
};

function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function seededLoro(): LoroDocType {
  const doc: LoroDocType = new LoroDoc();
  updateLoroToPmState(
    doc,
    new Map() as LoroNodeMapping,
    createEditorState(schema, CONTENT),
  );
  doc.commit();
  return doc;
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

function openView(doc: LoroDocType, initial: unknown, fastInit: boolean) {
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      doc: schema.nodeFromJSON(initial),
      plugins: [LoroSyncPlugin({ doc, fastInit })],
    }),
  });
  views.push(view);
  return view;
}

describe("fastInit", () => {
  test("keeps the editor's document instance when it already matches Loro", async () => {
    const view = openView(seededLoro(), CONTENT, true);
    const before = view.state.doc;
    await flushTimer();

    expect(view.state.doc).toBe(before);
    expect(view.state.doc.textContent).toBe("helloworld");
    // The mapping was built even though nothing was rendered: root, two
    // paragraphs, two texts.
    expect(loroSyncPluginKey.getState(view.state)?.mapping.size).toBe(5);
  });

  test("without the option, a matching document is still replaced", async () => {
    const view = openView(seededLoro(), CONTENT, false);
    const before = view.state.doc;
    await flushTimer();

    expect(view.state.doc).not.toBe(before);
    expect(view.state.doc.textContent).toBe("helloworld");
  });

  test("falls back to a full rebuild when the documents differ", async () => {
    const stale = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "something else" }],
        },
      ],
    };
    const view = openView(seededLoro(), stale, true);
    const before = view.state.doc;
    await flushTimer();

    expect(view.state.doc).not.toBe(before);
    expect(view.state.doc.textContent).toBe("helloworld");
    expect(loroSyncPluginKey.getState(view.state)?.mapping.size).toBe(5);
  });
});

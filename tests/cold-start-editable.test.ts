/**
 * @vitest-environment jsdom
 *
 * Collaboration cold start: an editor opened with content before the first
 * server import. Keystrokes typed in that window used to live only in
 * ProseMirror and were wiped by the first import's full rebuild.
 *
 * The editor is read-only during the window and editable once the first
 * import flips `loroReady` -- the same "not editable until synced" contract
 * as y-prosemirror.
 */

import { afterEach, describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const contentDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "existing server content here" }],
    },
  ],
};

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

describe("collaboration cold start", () => {
  test("editor is read-only until the first server import, then editable", async () => {
    // Empty Loro (server hasn't materialized yet) + PM built from document_tree
    // content + collaboration on: the cold-start "wait for server" branch.
    const doc: LoroDocType = new LoroDoc();
    const state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(contentDoc),
      plugins: [LoroSyncPlugin({ doc, collaboration: true })],
    });
    const view = new EditorView(document.createElement("div"), { state });
    views.push(view);

    // init() runs on the deferred tick and takes the wait-for-materialization
    // branch (loroReady=false). During this window typing would be lost, so the
    // editor must be read-only.
    await flushTimer();
    expect(view.editable).toBe(false);

    // Server materialization arrives: seed a source doc with the same tree and
    // import it into the plugin's doc, firing the first import event.
    const source: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    updateLoroToPmState(source, mapping, createEditorState(schema, contentDoc));
    source.commit();
    doc.import(source.export({ mode: "update" }));
    await flushTimer();

    // loroReady flipped → editing re-enabled.
    expect(view.editable).toBe(true);
  });
});

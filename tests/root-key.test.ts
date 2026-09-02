/**
 * @vitest-environment jsdom
 *
 * The name of the root container is configurable.
 *
 * The binding stores the document under a single top-level container whose
 * name has been hardcoded as `"doc"`. That name is a wire-format fact: it is
 * baked into every persisted snapshot and update, so an application that has
 * already written documents under a different name cannot adopt this library
 * without orphaning its own data, and one embedding a second top-level
 * container alongside the document cannot name them freely.
 *
 * `rootKey` makes the name an option. It defaults to `ROOT_DOC_KEY`, so every
 * existing caller is unaffected.
 */

import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  ROOT_DOC_KEY,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const CUSTOM_ROOT = "tree";

function paragraphState(text: string) {
  return createEditorState(schema, {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("configurable root container name", () => {
  test("defaults to ROOT_DOC_KEY when no rootKey is given", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map() as LoroNodeMapping,
      paragraphState("hi"),
    );
    doc.commit();

    expect(doc.getMap(ROOT_DOC_KEY).get("nodeName")).toBe("doc");
  });

  test("writes the document under the configured name instead", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map() as LoroNodeMapping,
      paragraphState("hi"),
      undefined,
      CUSTOM_ROOT,
    );
    doc.commit();

    expect((doc as LoroDoc).getMap(CUSTOM_ROOT).get("nodeName")).toBe("doc");
    // The default container must be untouched, or a document written under one
    // name would still be readable under the other and the option would be
    // silently doing nothing.
    expect(doc.getMap(ROOT_DOC_KEY).size).toBe(0);
  });

  test("the plugin reads back a document stored under the configured name", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map() as LoroNodeMapping,
      paragraphState("hello"),
      undefined,
      CUSTOM_ROOT,
    );
    doc.commit();

    const state = EditorState.create({
      schema,
      plugins: [LoroSyncPlugin({ doc, rootKey: CUSTOM_ROOT })],
    });
    const view = new EditorView(document.createElement("div"), { state });
    await flushTimer();

    expect(view.state.doc.textContent).toBe("hello");
    view.destroy();
  });
});

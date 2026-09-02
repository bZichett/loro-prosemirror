import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import type { LoroSyncPluginProps } from "../src/sync-plugin-key";
import {
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

export type PeerOptions = Omit<LoroSyncPluginProps, "doc">;

export function sync(from: LoroDoc, to: LoroDoc) {
  to.import(from.export({ mode: "update" }));
}

/** Flush the setTimeout(0) the plugin's view() uses to call init(). */
export function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Pre-populate a LoroDoc with one paragraph holding `text`. */
export function seedLoro(doc: LoroDocType, text: string) {
  seedLoroWith(doc, {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

/** Pre-populate a LoroDoc from a ProseMirror document JSON. */
export function seedLoroWith(doc: LoroDocType, content: unknown) {
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(doc, mapping, createEditorState(schema, content));
  doc.commit();
}

/** An EditorView bound to `doc` through LoroSyncPlugin. */
export function viewOver(doc: LoroDocType, options: PeerOptions = {}) {
  const state = EditorState.create({
    schema,
    plugins: [LoroSyncPlugin({ doc, ...options })],
  });
  return new EditorView(document.createElement("div"), { state });
}

/** A fresh LoroDoc seeded with `text`, and a view over it. */
export function createPeer(text: string, options: PeerOptions = {}) {
  const doc: LoroDocType = new LoroDoc();
  seedLoro(doc, text);
  return { doc, view: viewOver(doc, options) };
}

/** A peer whose doc is a sync of `sourceDoc`, and a view over it. */
export function createSyncedPeer(
  sourceDoc: LoroDoc,
  options: PeerOptions = {},
) {
  const doc: LoroDocType = new LoroDoc();
  sync(sourceDoc, doc);
  return { doc, view: viewOver(doc, options) };
}

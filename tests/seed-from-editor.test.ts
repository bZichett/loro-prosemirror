/**
 * @vitest-environment jsdom
 *
 * What init does when Loro is unpopulated but the editor holds content.
 *
 * By default Loro is the source of truth and the content is discarded. With
 * `seedFromEditor` the content is written into Loro under `sysInit`, so it is
 * recovered without landing on the undo stack. In collaboration mode an empty
 * scaffold is seeded the same way, giving the undo stack a baseline before the
 * first import; real content instead waits, which cold-start-editable.test.ts
 * covers.
 */

import { afterEach, describe, expect, test } from "vitest";
import { type Change, LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { LoroUndoPlugin } from "../src/undo-plugin";
import { loroUndoPluginKey } from "../src/undo-plugin-key";
import { type LoroSyncPluginProps } from "../src/sync-plugin-key";
import { LoroOrigins } from "../src/origins";
import { nestedListStrategy } from "../src/container-strategy";
import { type LoroDocType } from "../src/lib";

import { schema } from "./schema";

const CONTENT = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }],
};

function flushTimer(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function changesOf(doc: LoroDocType): Change[] {
  const [changes] = doc.getAllChanges().values();
  return changes ?? [];
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
});

function open(
  initial: unknown | undefined,
  options: Omit<LoroSyncPluginProps, "doc">,
) {
  const doc: LoroDocType = new LoroDoc();
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      schema,
      doc: initial === undefined ? undefined : schema.nodeFromJSON(initial),
      plugins: [LoroSyncPlugin({ doc, ...options }), LoroUndoPlugin({ doc })],
    }),
  });
  views.push(view);
  return { doc, view };
}

describe("init on an unpopulated Loro document", () => {
  test("by default the editor's content is discarded: Loro is the source of truth", async () => {
    const { doc, view } = open(CONTENT, {});
    await flushTimer();

    expect(view.state.doc.textContent).toBe("");
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(true);
  });

  test("seedFromEditor writes the content into Loro under sysInit, off the undo stack", async () => {
    const { doc, view } = open(CONTENT, { seedFromEditor: true });
    await flushTimer();

    expect(view.state.doc.textContent).toBe("kept");
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(false);
    expect(
      nestedListStrategy.read({ doc }, new Map(), schema)?.textContent,
    ).toBe("kept");
    // Every change so far is a bootstrap commit; none is undoable.
    for (const change of changesOf(doc)) {
      expect(change.message).toBe(LoroOrigins.sysInit);
    }
    expect(loroUndoPluginKey.getState(view.state)?.undoManager.canUndo()).toBe(
      false,
    );
  });

  test("in collaboration an empty scaffold is seeded and the editor is editable at once", async () => {
    const { doc, view } = open(undefined, { collaboration: true });
    await flushTimer();

    expect(view.editable).toBe(true);
    expect(nestedListStrategy.isUnpopulated({ doc })).toBe(false);
    for (const change of changesOf(doc)) {
      expect(change.message).toBe(LoroOrigins.sysInit);
    }
  });
});

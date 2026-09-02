/**
 * @vitest-environment jsdom
 *
 * A failing Loro runtime must not take the editor down with it.
 *
 * Two places can throw: init, which runs in a timer callback where an
 * exception would otherwise vanish, and the write-back on every local edit,
 * where one would recur on every keystroke. Both record `initError` on the
 * plugin state and disable sync; the editor keeps working on its own document.
 *
 * The container strategy is the seam: a strategy whose read or write throws
 * stands in for a WASM panic without mocking Loro.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import {
  type ContainerStrategy,
  nestedListStrategy,
} from "../src/container-strategy";
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

function seededLoro(text: string): LoroDocType {
  const doc: LoroDocType = new LoroDoc();
  updateLoroToPmState(
    doc,
    new Map() as LoroNodeMapping,
    createEditorState(schema, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }),
  );
  doc.commit();
  return doc;
}

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
  vi.restoreAllMocks();
});

function openView(doc: LoroDocType, container: ContainerStrategy) {
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      schema,
      plugins: [LoroSyncPlugin({ doc, container })],
    }),
  });
  views.push(view);
  return view;
}

describe("error boundary", () => {
  test("a throwing init records initError and leaves the view usable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failingRead: ContainerStrategy = {
      ...nestedListStrategy,
      read() {
        throw new Error("boom at init");
      },
    };
    const view = openView(seededLoro("hello"), failingRead);
    await flushTimer();

    expect(view.isDestroyed).toBe(false);
    expect(loroSyncPluginKey.getState(view.state)?.initError).toContain(
      "boom at init",
    );
  });

  test("a throwing write-back disables sync instead of recurring on every edit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let writes = 0;
    const failingWrite: ContainerStrategy = {
      ...nestedListStrategy,
      write() {
        writes++;
        throw new Error("boom on write");
      },
    };
    const view = openView(seededLoro("hello"), failingWrite);
    await flushTimer();
    expect(loroSyncPluginKey.getState(view.state)?.initError).toBeUndefined();

    const type = (text: string) => {
      const end = view.state.doc.content.size - 1;
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, end))
          .insertText(text),
      );
    };

    expect(() => type("!")).not.toThrow();
    expect(loroSyncPluginKey.getState(view.state)?.initError).toContain(
      "boom on write",
    );
    expect(writes).toBe(1);

    // Sync is off: the next edit neither throws nor reaches the strategy.
    expect(() => type("?")).not.toThrow();
    expect(writes).toBe(1);
    expect(view.state.doc.textContent).toBe("hello!?");
  });
});

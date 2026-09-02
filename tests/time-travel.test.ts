/**
 * @vitest-environment jsdom
 *
 * Time travel: `doc.checkout()` detaches the Loro document, and a detached
 * document is read-only. Two things follow for an application that renders
 * checkouts itself.
 *
 * Its render transaction must not trigger the plugin's write-back -- that
 * would commit onto the detached document. `LoroTxMeta.timeTravelSync` on
 * the transaction is what prevents it. And the plugin must not race the
 * application by rebuilding on the `checkout` event; `externalCheckout`
 * turns that rebuild off.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { LoroUndoPlugin } from "../src/undo-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import {
  type ContainerStrategy,
  nestedListStrategy,
} from "../src/container-strategy";
import { LoroTxMeta } from "../src/origins";
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

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) if (!v.isDestroyed) v.destroy();
  views.length = 0;
  vi.restoreAllMocks();
});

/** A view over a seeded doc, with a frontier taken before a second edit. */
async function seededWithHistory(
  externalCheckout: boolean,
  container: ContainerStrategy = nestedListStrategy,
) {
  const doc: LoroDocType = new LoroDoc();
  updateLoroToPmState(
    doc,
    new Map() as LoroNodeMapping,
    createEditorState(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      ],
    }),
  );
  doc.commit();

  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      schema,
      plugins: [
        LoroSyncPlugin({ doc, externalCheckout, container }),
        LoroUndoPlugin({ doc }),
      ],
    }),
  });
  views.push(view);
  await flushTimer();

  const before = doc.frontiers();
  const end = view.state.doc.content.size - 1;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, end))
      .insertText(" world"),
  );
  await flushTimer();
  expect(view.state.doc.textContent).toBe("hello world");

  return { doc, view, before };
}

/** What an application's own checkout render looks like. */
function renderCheckout(view: EditorView, doc: LoroDocType, withMeta: boolean) {
  const node = nestedListStrategy.read({ doc }, new Map(), view.state.schema);
  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );
  if (withMeta) tr.setMeta(LoroTxMeta.timeTravelSync, true);
  view.dispatch(tr);
}

describe("time travel", () => {
  test("by default a checkout event rebuilds the editor from the checked-out state", async () => {
    const { doc, view, before } = await seededWithHistory(false);

    doc.checkout(before);
    await flushTimer();

    expect(doc.isDetached()).toBe(true);
    expect(view.state.doc.textContent).toBe("hello");
  });

  test("with externalCheckout the plugin leaves the checkout event to the application", async () => {
    const { doc, view, before } = await seededWithHistory(true);

    doc.checkout(before);
    await flushTimer();

    expect(doc.isDetached()).toBe(true);
    expect(view.state.doc.textContent).toBe("hello world");
  });

  test("a render marked timeTravelSync is not written back, so the doc stays detached", async () => {
    const { doc, view, before } = await seededWithHistory(true);
    doc.checkout(before);
    await flushTimer();

    renderCheckout(view, doc, true);
    await flushTimer();

    expect(view.state.doc.textContent).toBe("hello");
    expect(doc.isDetached()).toBe(true);
    expect(loroSyncPluginKey.getState(view.state)?.initError).toBeUndefined();
  });

  test("the meta key is what suppresses the write-back", async () => {
    // A checkout render matches Loro's checked-out state exactly, so an
    // unmarked one diffs to nothing and happens not to mutate. That is luck,
    // not a guarantee, and it is not what the key promises: measure the
    // write-back itself. One user edit produces one write; the marked render
    // must produce none, and the unmarked render produces one.
    let writes = 0;
    const counting: ContainerStrategy = {
      ...nestedListStrategy,
      write(ref, mapping, editorState, origin) {
        writes++;
        nestedListStrategy.write(ref, mapping, editorState, origin);
      },
    };
    const { doc, view, before } = await seededWithHistory(true, counting);
    expect(writes).toBe(1);
    doc.checkout(before);
    await flushTimer();

    renderCheckout(view, doc, true);
    await flushTimer();
    expect(writes).toBe(1);

    renderCheckout(view, doc, false);
    await flushTimer();
    expect(writes).toBe(2);
  });
});

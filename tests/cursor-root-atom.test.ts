/**
 * Cursor resolution when the selection's containing node is the document
 * root, which happens at the end of any document whose last block is an atom.
 * The root's ProseMirror identity drifts on every rebuild, so it is recovered
 * structurally from the root container.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { LoroDoc } from "loro-crdt";
import { Schema, type Node as PmNode } from "prosemirror-model";

import {
  ROOT_DOC_KEY,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
  updateLoroToPmState,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "../src/cursor/common";
import type { LoroSyncPluginState } from "../src/sync-plugin-key";

import { createEditorState } from "./utils";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
    },
    // A nestable block container.
    container: {
      content: "block*",
      group: "block",
      toDOM: () => ["div", 0],
    },
    // A leaf atom: no content, blocks cursor descent. As the last child, the
    // end-of-doc position resolves at depth 0 with the root as its parent.
    embed: {
      group: "block",
      atom: true,
      toDOM: () => ["div", { class: "embed" }],
    },
    text: { group: "inline" },
  },
  marks: {},
  topNode: "doc",
});

const docJson = {
  type: "doc",
  content: [
    {
      type: "container",
      content: [
        {
          type: "container",
          content: [
            {
              type: "container",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "deep" }],
                },
              ],
            },
          ],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "trailing text" }] },
    { type: "embed" },
  ],
};

/**
 * Populate a Loro doc and mapping from `docJson`, then return a root node
 * whose identity has drifted from the mapped one while its children are
 * preserved by reference — what ProseMirror's slice-fit produces on
 * `tr.replace(0, size, Fragment.from(root))`.
 */
function setup(): {
  loroState: LoroSyncPluginState;
  mappedRoot: PmNode;
  driftedRoot: PmNode;
  rootContainerId: string;
} {
  const editorState = createEditorState(schema, docJson);
  const loroDoc: LoroDocType = new LoroDoc();
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(loroDoc, mapping, editorState);

  const mappedRoot = editorState.doc;
  const driftedRoot = schema.node("doc", null, mappedRoot.content);
  const rootContainerId = loroDoc.getMap(ROOT_DOC_KEY).id as unknown as string;

  const loroState = {
    doc: loroDoc,
    mapping,
    changedBy: "import",
  } as unknown as LoroSyncPluginState;

  return { loroState, mappedRoot, driftedRoot, rootContainerId };
}

describe("cursor resolution with a trailing atom + drifted root", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("end-of-doc selection on a drifted root resolves without a diagnostic", () => {
    const { loroState, driftedRoot, mappedRoot, rootContainerId } = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const endPos = driftedRoot.content.size;
    const selection = { anchor: endPos, head: endPos } as any;

    expect(() =>
      convertPmSelectionToCursors(driftedRoot, selection, loroState),
    ).not.toThrow();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    // The root container is recovered and re-bound to the live root.
    expect(loroState.mapping.get(rootContainerId as any)).toBe(driftedRoot);
    expect(WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(driftedRoot)).toBe(
      rootContainerId,
    );
    expect(loroState.mapping.get(rootContainerId as any)).not.toBe(mappedRoot);
  });

  test("a selection inside the 3-deep nested container still resolves", () => {
    const { loroState, driftedRoot } = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let deepPos = -1;
    driftedRoot.descendants((node, pos) => {
      if (node.isText && node.text === "deep") deepPos = pos + 1;
    });
    expect(deepPos).toBeGreaterThan(0);

    const selection = { anchor: deepPos, head: deepPos } as any;
    const { anchor } = convertPmSelectionToCursors(
      driftedRoot,
      selection,
      loroState,
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(anchor).toBeDefined();
    const [back] = cursorToAbsolutePosition(
      anchor!,
      loroState.doc as LoroDocType,
      loroState.mapping,
    );
    expect(back).toBeGreaterThan(0);
  });

  test("non-root selections in an atom-terminated doc round-trip", () => {
    const { loroState, driftedRoot } = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let pos = -1;
    driftedRoot.descendants((node, p) => {
      if (node.isText && node.text === "trailing text") pos = p + 2;
    });
    expect(pos).toBeGreaterThan(0);

    const selection = { anchor: pos, head: pos } as any;
    const { anchor } = convertPmSelectionToCursors(
      driftedRoot,
      selection,
      loroState,
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(anchor).toBeDefined();
  });
});

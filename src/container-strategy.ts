/**
 * How the document is laid out inside the Loro document.
 *
 * The binding has one layout today, a nested `LoroMap` / `LoroList` tree under
 * a single root container. Other layouts are possible — a `LoroTree`, whose
 * native move operation gives conflict-free reparenting, is the motivating
 * case — and they differ in every place the plugin touches the document:
 * writing the editor state in, reading it out, and deciding whether the root
 * is empty. This interface names those places so a layout is chosen once,
 * per plugin instance, instead of being re-detected at each of them.
 *
 * A strategy is always handed to the plugin, never discovered by inspecting
 * the document. Discovery is not safe: asking a Loro document for a root of
 * the wrong kind creates it, so probing a Map-backed document for a tree root
 * would corrupt it.
 */

import type { ContainerID } from "loro-crdt";
import type { Node, Schema } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import {
  createNodeFromLoroObj,
  getRootContainer,
  type LoroDocType,
  type LoroNodeMapping,
  type RenderOptions,
  tryGetLoroMapChildren,
  updateLoroToPmState,
} from "./lib";

/** Where the document lives: the Loro doc, and optionally a sub-container or a root name. */
export interface ContainerRef {
  doc: LoroDocType;
  containerId?: ContainerID;
  rootKey?: string;
}

export interface ContainerStrategy {
  /** Write the editor document into Loro and commit it under `origin`. */
  write(
    ref: ContainerRef,
    mapping: LoroNodeMapping,
    editorState: EditorState,
    origin?: string,
  ): void;

  /**
   * Read the Loro document into a ProseMirror node, repopulating `mapping`.
   * Returns null when the content has no valid representation in the schema.
   */
  read(
    ref: ContainerRef,
    mapping: LoroNodeMapping,
    schema: Schema,
    options?: RenderOptions,
  ): Node | null;

  /**
   * Whether the root has never been written. Distinct from {@link isEmpty}:
   * an unpopulated root is one nothing has been synced into yet, which init
   * treats as "seed from the editor"; an empty one has had every block
   * removed, which the update path renders as an empty document.
   */
  isUnpopulated(ref: ContainerRef): boolean;

  /**
   * Whether the root holds zero blocks. Must answer false, not true, for a
   * root it cannot read — a container it failed to resolve is a broken read,
   * not an empty document, and reporting it empty would let the update path
   * blank content it merely failed to load.
   */
  isEmpty(ref: ContainerRef): boolean;

  /**
   * Whether the `fastInit` / `fastTextSync` paths apply. They walk the nested
   * Map/List layout directly, so a strategy with a different layout answers
   * false and always takes the full read.
   */
  readonly fastPaths: boolean;
}

/** The nested `LoroMap` / `LoroList` layout: the default, and the only one upstream ships. */
export const nestedListStrategy: ContainerStrategy = {
  write(ref, mapping, editorState, origin) {
    updateLoroToPmState(ref.doc, mapping, editorState, ref.containerId, {
      rootKey: ref.rootKey,
      origin,
    });
  },

  read(ref, mapping, schema, options) {
    return createNodeFromLoroObj(
      schema,
      getRootContainer(ref.doc, ref.containerId, ref.rootKey),
      mapping,
      options,
    );
  },

  isUnpopulated(ref) {
    return getRootContainer(ref.doc, ref.containerId, ref.rootKey).size === 0;
  },

  isEmpty(ref) {
    const children = tryGetLoroMapChildren(
      getRootContainer(ref.doc, ref.containerId, ref.rootKey),
    );
    return children !== undefined && children.length === 0;
  },

  fastPaths: true,
};

/**
 * A strategy, or a function choosing one from the editor's root node type.
 * The function form lets an application route archetypes to layouts —
 * editorial documents to a tree, append-only transcripts to a list — while
 * keeping the choice a fact the application states rather than the plugin
 * infers.
 */
export type ContainerStrategySelector =
  | ContainerStrategy
  | ((rootNodeName: string) => ContainerStrategy);

export function resolveContainerStrategy(
  selector: ContainerStrategySelector | undefined,
  rootNodeName: string,
): ContainerStrategy {
  if (selector === undefined) return nestedListStrategy;
  return typeof selector === "function" ? selector(rootNodeName) : selector;
}

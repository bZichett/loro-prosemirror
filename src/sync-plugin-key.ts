import type { ContainerID, Cursor, LoroDoc, Subscription } from "loro-crdt";
import { PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDocType, LoroNodeMapping } from "./lib";

export const loroSyncPluginKey = new PluginKey<LoroSyncPluginState>(
  "loro-sync",
);

export interface LoroSyncPluginProps {
  doc: LoroDocType;
  mapping?: LoroNodeMapping;
  containerId?: ContainerID;
}

export interface LoroSyncPluginState extends LoroSyncPluginProps {
  changedBy: "local" | "import" | "checkout";
  mapping: LoroNodeMapping;
  snapshot?: LoroDoc | null;
  view?: EditorView;
  containerId?: ContainerID;
  docSubscription?: Subscription | null;
  /** Loro stable cursor saved when PM ↔ Loro are in sync (after local edits). */
  savedAnchor?: Cursor;
  savedFocus?: Cursor;
}

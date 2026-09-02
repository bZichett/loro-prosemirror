import type { ContainerID, Cursor, LoroDoc, Subscription } from "loro-crdt";
import { PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDocType, LoroNodeMapping, SchemaViolationInfo } from "./lib";

export const loroSyncPluginKey = new PluginKey<LoroSyncPluginState>(
  "loro-sync",
);

export interface LoroSyncPluginProps {
  doc: LoroDocType;
  mapping?: LoroNodeMapping;
  containerId?: ContainerID;
  /**
   * Name of the top-level container holding the document. Defaults to
   * `ROOT_DOC_KEY`; ignored when `containerId` is given.
   *
   * The name is part of the wire format, baked into every persisted snapshot
   * and update, so it cannot be changed for a document that already exists.
   */
  rootKey?: string;
  /**
   * Called when merged content cannot be expressed in the editor's schema, so
   * the affected node is left out of the ProseMirror document.
   *
   * Concurrent edits can converge on a document the schema rejects -- Loro
   * guarantees convergence, not well-formedness. The content stays in the Loro
   * document and reappears once the conflict resolves; this hook exists so an
   * application can notice that it happened. Without it the violation is only
   * written to `console.error`.
   */
  onSchemaViolation?: (info: SchemaViolationInfo) => void;
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

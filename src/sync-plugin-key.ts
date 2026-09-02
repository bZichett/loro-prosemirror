import type { ContainerID, Cursor, LoroDoc, Subscription } from "loro-crdt";
import { PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type {
  ContainerStrategy,
  ContainerStrategySelector,
} from "./container-strategy";
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
   * How the document is laid out inside Loro. Defaults to the nested
   * Map/List layout. A function receives the editor's root node type and
   * chooses per document. See `container-strategy.ts`.
   */
  container?: ContainerStrategySelector;
  /**
   * On init, when the editor's document already matches the Loro document
   * structurally, build the container mapping by walking the two in parallel
   * instead of replacing the document. Plugin decorations survive. Falls back
   * to the ordinary full rebuild on any mismatch. Default false.
   */
  fastInit?: boolean;
  /**
   * Apply remote plain-text edits as targeted ProseMirror steps instead of
   * rebuilding the document, so cursors and decorations are remapped by
   * ProseMirror rather than reset. Falls back to the ordinary full rebuild
   * whenever an eligibility check fails. Default false.
   */
  fastTextSync?: boolean;
  /**
   * The application renders time-travel checkouts itself, marking each such
   * render with `LoroTxMeta.timeTravelSync`. When true the plugin ignores
   * `checkout` events instead of rebuilding the document from the checked-out
   * state, so the two renders cannot race. Default false.
   */
  externalCheckout?: boolean;
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
  /** The `container` selector resolved against this editor's root node type. */
  strategy: ContainerStrategy;
  snapshot?: LoroDoc | null;
  view?: EditorView;
  containerId?: ContainerID;
  docSubscription?: Subscription | null;
  /** Loro stable cursor saved when PM ↔ Loro are in sync (after local edits). */
  savedAnchor?: Cursor;
  savedFocus?: Cursor;
  /**
   * Set when init or a write-back threw. Sync is disabled from then on, so a
   * failing Loro runtime cannot throw on every keystroke; the editor keeps
   * working on its own document. A consumer can read this to show an error
   * state.
   */
  initError?: string;
}

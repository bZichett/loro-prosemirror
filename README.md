# Prosemirror Binding for Loro

- Sync document state with Loro
- Sync cursors with Loro's EphemeralStore (preferred) or legacy Awareness and
  [Cursor](https://loro.dev/docs/tutorial/cursor)
- Undo/Redo in collaborative editing
- [🎨 Try it online](https://main--6661e86e215da40180d90507.chromatic.com)

```ts
import {
  CursorEphemeralStore,
  LoroEphemeralCursorPlugin,
  LoroSyncPlugin,
  LoroUndoPlugin,
  redo,
  undo,
} from "loro-prosemirror";
import { LoroDoc } from "loro-crdt";
import { EditorView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";

const doc = new LoroDoc();
const presence = new CursorEphemeralStore(doc.peerIdStr);

const plugins = [
  ...pmPlugins,
  LoroSyncPlugin({ doc }),
  LoroUndoPlugin({ doc }),
  keymap({
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
  }),
  LoroEphemeralCursorPlugin(presence, {}),
];
const editor = new EditorView(editorDom, {
  state: EditorState.create({ doc, plugins }),
});
```

https://github.com/loro-dev/prosemirror/assets/18425020/d0f01760-b76c-43b5-b7f7-b0b224130d9d

## Syncing more than one editor instance

In case you want to sync multiple ProseMirror editor instances to the same Loro document, you can define for each ProseMirror editor the [Container ID](https://loro.dev/docs/advanced/cid) into which the editor's content will be stored:

```ts
const doc = new LoroDoc();
const map = doc.getMap("<unique-id-per-editor-instance>");

const plugins = [
  LoroSyncPlugin({ doc, containerId: map.id }),
  // see above for other plugins
];
```

### Container layout

By default the document is stored as a nested `LoroMap` / `LoroList` tree under a single root container. Pass `container: treeStrategy` to store it as a `LoroTree` instead, whose native move operation keeps a reparented block's identity — and any concurrent edit inside it — across the move:

```ts
import { LoroSyncPlugin, treeStrategy } from "loro-prosemirror";

LoroSyncPlugin({ doc, container: treeStrategy });
```

The layout is a wire-format fact: choose it once per document and hand it in every time. It is never detected from the document, because asking Loro for a root of the wrong kind creates one. `container` also accepts a function of the editor's root node type, so an application can route document kinds to layouts. `fastInit` and `fastTextSync` apply to the nested layout only.

## Observing schema violations

Loro guarantees that concurrent edits converge — not that they converge on a
document your ProseMirror schema accepts. Two peers can each hold a valid
document whose merge is a node the schema rejects (for example, a node whose
`content` expression no longer matches after both sides edited its children).

When that happens the offending node is left out of the ProseMirror document,
because it cannot be built. It is **kept in the Loro document**, so it is not
lost and reappears once the conflict resolves. Pass `onSchemaViolation` to be
told when it happens:

```ts
LoroSyncPlugin({
  doc,
  onSchemaViolation: ({ containerId, nodeName, cause }) => {
    reportToTelemetry({ containerId, nodeName, cause });
  },
});
```

Without the callback the violation is written to `console.error`.

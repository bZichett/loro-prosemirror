# Operational (Step-based) sync — investigation notes

Working notes for the next phase, written to survive a session teleport.
**These are notes, not a proposal to merge.** Drop this commit before opening a
PR if you don't want it in the diff.

---

## 1. Where the branch stands

Branch `claude/logic-math-language-zech0j`. **Lint, format and tests are all
green** (17 passed, 3 skipped).

| Commit    | What                                                                |
| --------- | ------------------------------------------------------------------- |
| `7fe91fc` | Red-light tests for schema-violating merges (marked `test.fails`)   |
| `39b9e99` | The fixes — turns all four green                                    |
| `16ca4ff` | Property-based merge fuzzer                                         |
| `729cb66` | Fixes the pre-existing lint + format failures inherited from main   |
| `a4eaa70` | Child-process test runs go through node, helper in `tests/utils.ts` |
| `f01f39b` | gitignore Claude Code per-machine state                             |

Fixed in `39b9e99`:

1. **Non-termination.** `updateLoroMapChildren`'s middle loop captured
   `loroMidEnd`/`pmMidEnd` as `const` before the loop, but the `updateRight`
   branch signals progress only by incrementing `right`. That branch advanced
   nothing → synchronous infinite loop → frozen tab. Regression from `a49df75`.
2. **Silent data loss.** A container the schema couldn't render was dropped
   from the mapping, so the next local edit's diff read its absence as a user
   deletion and deleted it from the CRDT for every peer, permanently. Such
   containers are now marked `UNRENDERABLE` _in the mapping_ — which both sync
   directions already share, so existing callers are protected with no
   signature changes.
3. **Observability.** `onSchemaViolation` on `LoroSyncPluginProps`, plus
   `RenderOptions`/`isUnrenderable` exported.

Still true after the fix: an unrenderable node **does not render**. It is safe
and returns when the conflict clears. Repairing it (`ContentMatch.fillBefore`)
was deliberately out of scope.

`main` had two red CI jobs when this work started — 3 `tsc` errors in
`src/sync-plugin.ts` and 3 unformatted test files. Both are fixed in `729cb66`,
kept separate from the bug-fix commits so the diff stays honest about what was
already broken.

---

## 2. A correction to earlier reasoning

Earlier in the session I claimed step-translation "is what a Y.js-style binding
typically translates." **That is false**, and the correction matters.

y-prosemirror does the same structural diff this repo does. Verified from
source (`unpkg.com/y-prosemirror@1.2.12/src/plugins/sync-plugin.js`):

```js
_prosemirrorChanged (doc) {
  this.doc.transact(() => {
    updateYFragment(this.doc, this.type, doc, this.mapping)
    ...
```

Whole document in, structural re-diff, never reads `tr.steps`.

And this repo is **a port of y-prosemirror**, not merely similar to it:

- `computeChildEqualityFactor` is y-prosemirror's function name
- `updateLoroMapChildren` is its `updateYFragment`
- `lib0` — Yjs's own utility library — is a direct runtime dependency here,
  purely for `simpleDiff` and `equalityDeep`

Consequence: diverging from the diff means losing the ability to port
upstream's fixes. This repo has clearly been taking them (the split-brain
reconciliation, the equality-factor logic).

---

## 3. Prior art — the useful finding

`@automerge/prosemirror` **does** translate steps. From `src/pmToAm.ts`:

```ts
export default function (
  adapter: SchemaAdapter,
  spans: am.Span[],
  steps: Step[],
  doc: any,
  pmDoc: Node,
  path: Prop[],
);
```

dispatching in `oneStep`:

```ts
if (stepId === "replace") { replaceStep(...) }
else if (stepId === "replaceAround") { replaceAroundStep(...) }
else if (stepId === "removeMark") { removeMarkStep(...) }
```

with `addMark` steps buffered in `unappliedMarks` and flushed when a
non-`addMark` step arrives.

**The important part:** `ReplaceAroundStep` — and complex `ReplaceStep` cases —
are handled by applying the step to the ProseMirror document and then
converting the whole resulting node tree back via `updateSpans()`, abandoning
fine-grained position tracking.

So the one binding that does step translation **still falls back to a re-diff
for the hard step.** That is exactly the hybrid architecture below, validated by
a shipped implementation.

### Two caveats that make Automerge's job easier than ours

- **They constrain the schema.** `@automerge/prosemirror` requires a
  `SchemaAdapter` mapping a specific subset of ProseMirror onto Automerge's
  rich-text model. `loro-prosemirror` accepts arbitrary schemas.
- **Their data model is flat.** Automerge represents rich text as a text
  sequence with block markers and spans. Position arithmetic over a flat
  sequence is dramatically simpler than over Loro's nested
  `LoroMap`/`LoroList` tree.

Do not read "Automerge did it" as "this is easy here." Read it as "the hybrid
shape is right, and the hard step is hard for everyone."

---

## 4. Measurements taken in this repo

|                                                       |                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Step subclasses in the pinned `prosemirror-transform` | 8 — `Replace`, `ReplaceAround`, `AddMark`, `RemoveMark`, `AddNodeMark`, `RemoveNodeMark`, `Attr`, `DocAttr` |
| Existing step handling in `src/`                      | **none** — no `tr.steps`, no `Step`, no ProseMirror `Mapping`                                               |
| `lib.ts` total                                        | 919 lines                                                                                                   |
| Diff/alignment machinery within it                    | ~473 lines (`reconcileSplitBrainTexts` :318 → end of `updateLoroMapChildren` :666+)                         |
| `appendTransaction` (`sync-plugin.ts:113`)            | already receives the transactions, discards them, sets a `doc-changed` flag                                 |

### The position-mapping trap

`cursorToAbsolutePosition` (`src/cursor/common.ts:348`) looks like the primitive
a step translator needs. **It is not.** It is a best-effort _cursor_ resolver
with lossy fallbacks — it returns `[1, undefined]` when it can't resolve a
container. Landing a cursor approximately is fine. Landing an _edit_
approximately corrupts the document. A step translator needs a total, exact
position↔container mapping, and that is its own project.

---

## 5. Recommended approach: fast path with fallback

Do **not** replace the diff. Add a fast path in front of it.

In `appendTransaction`, inspect `tr.steps`. If **every** step is a
`ReplaceStep` whose slice is plain text within a single text block — typing,
backspace, paste-into-a-paragraph, i.e. the overwhelming majority of real edits
— translate directly to `LoroText.insert` / `LoroText.delete` at a resolved
offset. **Anything else at all**: fall through to `updateLoroToPmState` exactly
as today.

Why this shape:

- **Completeness is not required.** Unhandled steps take the existing path,
  which already works.
- **Reversible.** One flag disables the fast path.
- **Verifiable.** The fuzzer can run both paths over the same op list and
  assert identical resulting documents (see §6).
- Captures most of the win, because typing is what happens per keystroke.

### Sketch

1. Add `stepsToLoroOps(steps, state, mapping): LoroOp[] | null` — returns
   `null` the moment it sees anything it doesn't fully understand.
2. Gate on: single `ReplaceStep`, `step.slice` has `openStart === 0 &&
openEnd === 0`, content is text-only, `$from.parent === $to.parent`, parent
   `isTextblock`, and the parent maps to a known `LoroText` container.
3. Resolve the offset **within that text container**, not the document — this
   sidesteps the global position-mapping problem entirely. That restriction is
   what makes the fast path tractable.
4. On `null`, call `updateLoroToPmState` unchanged.

Note the ordering constraint: `appendTransaction` currently just flags
`doc-changed` and the write-back happens later. The fast path needs the steps
_and_ the pre-step document state, so check where the write-back actually
fires (`sync-plugin.ts` `apply` → `doc-changed`) before wiring it in.

---

## 6. How to verify it

The fuzzer (`tests/fuzz/merge-fuzz.ts`) already generates the hard cases.
Add a **differential property**: run each generated op list twice, once with
the fast path enabled and once forced off, and assert the resulting Loro
documents are byte-identical. That converts "did I translate this step
correctly" into a generated question rather than a reviewed one.

Existing properties: `convergence`, `renders`, `no-amplification`,
`conservation`. Campaigns run in a child process with a wall-clock timeout
because termination is itself under test.

```bash
pnpm test                                                # everything
RUN_FUZZ=1 npx vitest run tests/merge-fuzz.test.ts       # fuzz in-process, for debugging
FUZZ_ITERATIONS=5000 FUZZ_SEED=42 RUN_FUZZ=1 npx vitest run tests/merge-fuzz.test.ts
```

The child process is spawned by `runVitestInChild` in `tests/utils.ts`, which
resolves vitest through `require.resolve("vitest/vitest.mjs")` rather than
shelling out to `npx`. A differential property would reuse that same harness.

Failures print the seed and a delta-debugged minimal op list. Ops are data and
positions are stored as fractions resolved at execution time, so removing an op
can never invalidate another — shrinking is sound.

---

## 7. Honest estimate

- **Text-only fast path + fallback:** a few days. Low risk. Removes
  O(document) work from the common keystroke.
- **Full step coverage replacing the diff:** weeks, novel design, and you must
  build the total position↔container mapping first. `ReplaceAroundStep`
  (wrap/lift) is the genuinely hard part — Automerge punts on it, and they had
  the easier data model.

Recommendation: do the fast path, keep the diff. Revisit the full rewrite only
if profiling on a real document says the remaining diff cost still hurts.

---

## 8. Local setup after teleport

```bash
pnpm install          # node_modules does not come across
pnpm test             # expect 17 passed, 3 skipped
pnpm lint             # clean
pnpm run check-format # clean
```

Outstanding, unrelated to step sync:

- open the PR (CI is green now)
- widen the fuzzer: a **recovery** property (does the `UNRENDERABLE` marker
  actually clear when the conflict resolves? — currently traced by reading, not
  by testing), undo/redo ops, structural edits, a third peer

---

## Sources

- y-prosemirror sync plugin — https://unpkg.com/y-prosemirror@1.2.12/src/plugins/sync-plugin.js
- automerge-prosemirror `pmToAm` — https://github.com/automerge/automerge-prosemirror
- `@automerge/prosemirror` — https://www.npmjs.com/package/@automerge/prosemirror
- Writing a ProseMirror plugin for Automerge — https://discuss.prosemirror.net/t/writing-a-prosemirror-plugin-for-automerge/5362
- ProseMirror + CRDTs — https://discuss.prosemirror.net/t/prosemirror-crdts/1190

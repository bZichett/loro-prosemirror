/**
 * Isolated reproduction of the `updateLoroMapChildren` non-termination bug.
 *
 * This file is NOT part of the normal test run: the loop it exercises spins
 * forever on the current code, and a synchronous infinite loop cannot be
 * interrupted by vitest's `testTimeout` (it never yields to the event loop),
 * so including it directly would wedge CI until the job-level timeout.
 *
 * `tests/schema-violation.test.ts` runs this file in a child process with a
 * wall-clock timeout instead. Set RUN_HANG_REPRO=1 to execute it.
 */
import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { describe, test } from "vitest";
import {
  type LoroDocType,
  type LoroNodeMapping,
  updateLoroToPmState,
} from "../src/lib";
import { schema } from "./schema";

const P = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const LIST = {
  type: "bulletList",
  content: [{ type: "listItem", content: [P("a")] }],
};

function stateOf(json: unknown) {
  return EditorState.create({ doc: schema.nodeFromJSON(json), schema });
}

describe.runIf(process.env.RUN_HANG_REPRO)("hang repro", () => {
  test("updateLoroMapChildren terminates on structural divergence", () => {
    const doc: LoroDocType = new LoroDoc();

    // Loro holds [bulletList, paragraph "x"].
    updateLoroToPmState(
      doc,
      new Map(),
      stateOf({ type: "doc", content: [LIST, P("x")] }),
    );
    doc.commit();

    // Write back [paragraph "p", paragraph "y"] with a fresh mapping, as
    // happens after `clearChangedNodes` drops mappings on a remote import.
    //
    // The left scan breaks (bulletList != paragraph) and the right scan breaks
    // (text differs), so the middle loop runs with leftLoro=bulletList and
    // rightLoro=paragraph. That selects the `updateRight` branch, which only
    // increments `right` -- but the loop bounds `loroMidEnd`/`pmMidEnd` were
    // captured as consts before the loop, so neither index advances.
    const mapping: LoroNodeMapping = new Map();
    updateLoroToPmState(
      doc,
      mapping,
      stateOf({ type: "doc", content: [P("p"), P("y")] }),
    );
  });
});

import { describe, expect, test } from "vitest";
import { LoroDoc } from "loro-crdt";

import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNodeMapping,
} from "../src/lib";
import { buildMappingFromExistingDoc } from "../src/build-mapping";

import { schema } from "./schema";

/**
 * The fast mapping walk is a read path. It must use the non-creating
 * `tryGetLoroMapChildren`: the creating getter auto-commits, which throws
 * "Auto commit has not started" on a detached document. A missing `children`
 * container is a structural mismatch, reported as `false` so the caller falls
 * back to a full rebuild, never a crash.
 */
describe("buildMappingFromExistingDoc on a missing children container", () => {
  test("returns false rather than throwing when the root has no children container", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY);
    // Bootstrap-frontier shape: nodeName set, no children container created.
    root.set("nodeName", "doc");
    doc.commit();

    const pmRoot = schema.node("doc", {}, []);
    const mapping: LoroNodeMapping = new Map();

    expect(buildMappingFromExistingDoc(root, pmRoot, mapping)).toBe(false);
  });
});

/**
 * Property-based fuzzing of concurrent merges.
 *
 * The campaigns run in a child process with a wall-clock timeout: one of the
 * properties under test is that the write-back terminates, and a synchronous
 * infinite loop cannot be interrupted by vitest's testTimeout. Running them
 * here directly would wedge CI instead of failing it.
 *
 * Replay a reported failure directly with:
 *   RUN_FUZZ=1 npx vitest run tests/merge-fuzz.test.ts
 */
import { describe, test } from "vitest";
import { runCampaign } from "./fuzz/merge-fuzz";
import { runVitestInChild } from "./utils";

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 250);
const SEED = Number(process.env.FUZZ_SEED ?? 1);

describe.runIf(process.env.RUN_FUZZ)("merge properties", () => {
  test("hold for concurrent ProseMirror edits", () => {
    runCampaign({
      seed: SEED,
      iterations: ITERATIONS,
      maxOps: 10,
      adversarial: false,
      label: "concurrent edits",
    });
  }, 120_000);

  test("hold when a peer writes content the schema rejects", () => {
    runCampaign({
      seed: SEED + 1_000_000,
      iterations: ITERATIONS,
      maxOps: 10,
      adversarial: true,
      label: "adversarial merges",
    });
  }, 120_000);
});

describe.skipIf(process.env.RUN_FUZZ)("merge fuzzing", () => {
  test("campaigns pass", () => {
    runVitestInChild("tests/merge-fuzz.test.ts", { RUN_FUZZ: "1" }, 180_000);
  }, 240_000);
});

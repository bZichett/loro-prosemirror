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
import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";
import { runCampaign } from "./fuzz/merge-fuzz";

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
    try {
      execFileSync(
        "npx",
        ["vitest", "run", "tests/merge-fuzz.test.ts", "--reporter=basic"],
        {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, RUN_FUZZ: "1", CI: "1" },
          timeout: 180_000,
          stdio: "pipe",
        },
      );
    } catch (e) {
      const err = e as { stdout?: Buffer; signal?: string };
      if (err.signal === "SIGTERM") {
        throw new Error(
          "fuzz campaign did not terminate within 180s -- likely a " +
            "non-terminating loop in the write-back path",
        );
      }
      throw new Error(String(err.stdout ?? e));
    }
  }, 240_000);
});

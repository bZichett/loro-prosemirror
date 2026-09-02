import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  type LoroNode,
  getLoroMapAttributes,
  getLoroMapChildren,
} from "../src/lib";
import { LoroList, LoroMap, LoroText } from "loro-crdt";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * Run a test file in a child process with a wall-clock timeout.
 *
 * Some properties -- that the write-back terminates, above all -- cannot be
 * checked in process, because a synchronous infinite loop never yields to the
 * event loop and vitest's `testTimeout` never fires. Those files guard
 * themselves behind an env var and are driven from here instead.
 *
 * Resolves vitest through Node rather than `npx`: `npx` falls back to fetching
 * from the registry by name, which would silently run a different version than
 * the one the repository depends on.
 */
export function runVitestInChild(
  testFile: string,
  env: Record<string, string>,
  timeoutMs: number,
): void {
  const require = createRequire(import.meta.url);
  try {
    execFileSync(
      process.execPath,
      [
        require.resolve("vitest/vitest.mjs"),
        "run",
        testFile,
        "--reporter=basic",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env, CI: "1" },
        timeout: timeoutMs,
        stdio: "pipe",
      },
    );
  } catch (e) {
    const err = e as { stdout?: Buffer; signal?: string };
    if (err.signal === "SIGTERM") {
      throw new Error(
        `${testFile} did not terminate within ${timeoutMs}ms -- likely a ` +
          `non-terminating loop in the write-back path`,
      );
    }
    throw new Error(String(err.stdout ?? e));
  }
}

export function createEditorState(schema: Schema, content: any): EditorState {
  const doc = schema.nodeFromJSON(content);
  return EditorState.create({
    doc,
    schema,
  });
}

export function insertLoroText(parent: LoroList): LoroText {
  return parent.insertContainer(parent.length, new LoroText());
}

export function insertLoroMap(parent: LoroList, nodeName: string): LoroNode {
  const obj = parent.insertContainer(parent.length, new LoroMap());
  setupLoroMap(obj, nodeName);
  return obj as unknown as LoroNode;
}

export function setupLoroMap(obj: LoroMap, nodeName: string): void {
  obj.set("nodeName", nodeName);
  getLoroMapChildren(obj as unknown as LoroNode);
  getLoroMapAttributes(obj as unknown as LoroNode);
}

export function oneMs(): Promise<void> {
  return new Promise((r) => setTimeout(r));
}

/** A node map with only its `nodeName`: no `children` or `attributes` container yet. */
export function insertBareLoroMap(
  parent: LoroList,
  nodeName: string,
): LoroNode {
  const obj = parent.insertContainer(parent.length, new LoroMap());
  obj.set("nodeName", nodeName);
  return obj as unknown as LoroNode;
}

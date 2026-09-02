/**
 * Change-granularity bench — what narrowing `change_merge_interval` costs.
 *
 * ## The rule, as measured (not as the docs read)
 *
 * Loro folds a commit into the open change while
 * `commit.timestamp - change.startTimestamp <= change_merge_interval`.
 * The window runs from the change's FIRST commit, not the previous one, and
 * the comparison is inclusive. So the interval is a **maximum change
 * duration**, not a minimum pause: at 5s a bar covers up to 5 seconds of
 * active editing, however continuously you type.
 *
 * `DEFAULT_MERGE_INTERVAL` below is Loro's own default, binary-searched from
 * the runtime — 1000 seconds. It matters because it makes
 * "record timestamps, leave the interval alone" a real candidate rather than
 * a no-op.
 *
 * ## What is replayed
 *
 * A writing session through the real PM -> Loro write path (`updateLoroTree`
 * then `doc.commit()`, one commit per ProseMirror transaction, exactly as
 * `sync-plugin.ts` does on every keystroke) against a simulated clock driven
 * by `doc.setNextCommitTimestamp()`. A 90-minute session therefore measures in
 * seconds and the numbers are deterministic.
 *
 *   bun bench/change-granularity.ts
 *   bun bench/change-granularity.ts --sessions 30            # history depth
 *   bun bench/change-granularity.ts --corpus /tmp/corpus.json --json
 *
 * Session-model flags (seconds unless noted): --cps, --sentence-pause,
 * --block-pause, --stint-pause, --stint-blocks, --sessions, --session-gap
 * (hours between sessions), --intervals 5,30,60,300.
 */
import { EditorState } from "prosemirror-state";
import { LoroDoc } from "loro-crdt";
import type { Change, PeerID } from "loro-crdt";

import { updateLoroTree } from "../src/tree-diff";
import { type LoroNodeMapping } from "../src/lib";
import { getRootTree } from "../src/tree-build";
import { schema } from "../tests/schema";
import { defaultCorpus } from "./corpus";

/** Loro's own default, measured: the largest gap that still merges. */
const DEFAULT_MERGE_INTERVAL = 1000;

/** Wall-clock epoch seconds the simulated session starts at — fixed so runs compare. */
const T0 = 1_767_225_600; // 2026-01-01T00:00:00Z

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

interface SessionModel {
  /** Characters per second while actively typing. */
  cps: number;
  /** Extra pause after a sentence-ending character. */
  sentencePause: number;
  /** Extra pause between blocks (think / scroll / re-read). */
  blockPause: number;
  /** Extra pause every `stintBlocks` blocks (a break in the work). */
  stintPause: number;
  stintBlocks: number;
  /** How many times the whole session repeats — history depth on one document. */
  sessions: number;
  /** Hours between repeated sessions. */
  sessionGapHours: number;
}

const DEFAULT_MODEL: SessionModel = {
  cps: 5,
  sentencePause: 4,
  blockPause: 45,
  stintPause: 900,
  stintBlocks: 15,
  sessions: 1,
  sessionGapHours: 24,
};

/**
 * One entry per ProseMirror transaction, carrying the simulated wall-clock
 * second it commits at. Built once and replayed at every interval, so every
 * run sees an identical op stream and the only variable is where Loro splits.
 */
interface Keystroke {
  /** `null` = press Enter (new block); otherwise the character typed. */
  ch: string | null;
  timestamp: number;
}

function buildSession(corpus: string[], m: SessionModel): Keystroke[] {
  const strokes: Keystroke[] = [];
  let t = T0;
  for (let s = 0; s < m.sessions; s++) {
    if (s > 0) t += m.sessionGapHours * 3600;
    for (let bi = 0; bi < corpus.length; bi++) {
      if (bi > 0 || s > 0) {
        t += m.blockPause;
        if (bi > 0 && bi % m.stintBlocks === 0) t += m.stintPause;
        strokes.push({ ch: null, timestamp: Math.floor(t) });
      }
      for (const ch of corpus[bi]!) {
        t += 1 / m.cps;
        if (ch === "." || ch === "?" || ch === "!") t += m.sentencePause;
        strokes.push({ ch, timestamp: Math.floor(t) });
      }
    }
  }
  return strokes;
}

/** Seconds in which at least one commit landed — the session's ACTIVE span. */
function activeSeconds(strokes: Keystroke[]): number {
  return new Set(strokes.map((s) => s.timestamp)).size;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** `null` interval = leave Loro's default. `stamp: false` = ship-today behaviour. */
interface Variant {
  label: string;
  interval: number | null;
  stamp: boolean;
}

interface RunResult {
  label: string;
  changes: number;
  ops: number;
  oplogBytes: number;
  snapshotBytes: number;
  wireBytes: number;
  wireBlobs: number;
  replayMs: number;
}

function emptyEditorialDoc() {
  // `doc` is the LoroTree (editorial) archetype — see TREE_ARCHETYPES in src/lib.ts.
  return schema.node("doc", null, [schema.node("paragraph")]);
}

function replay(
  strokes: Keystroke[],
  v: Variant,
): { doc: LoroDoc; blobs: Uint8Array[]; result: RunResult } {
  const doc = new LoroDoc();
  doc.setPeerId("1" as PeerID);
  doc.setRecordTimestamp(v.stamp);
  if (v.interval !== null) doc.setChangeMergeInterval(v.interval);

  const blobs: Uint8Array[] = [];
  const unsub = doc.subscribeLocalUpdates((bytes) =>
    blobs.push(new Uint8Array(bytes)),
  );

  const mapping: LoroNodeMapping = new Map();
  let state = EditorState.create({ schema, doc: emptyEditorialDoc() });
  const tree = getRootTree(doc);
  const started = performance.now();

  for (const stroke of strokes) {
    const tr =
      stroke.ch === null
        ? state.tr.insert(state.doc.content.size, schema.node("paragraph"))
        : state.tr.insertText(stroke.ch, state.doc.content.size - 1);
    state = state.apply(tr);

    if (v.stamp) doc.setNextCommitTimestamp(stroke.timestamp);
    updateLoroTree(tree, state.doc, mapping);
    doc.commit({ origin: "local", message: "local" });
  }

  const replayMs = performance.now() - started;
  unsub();

  return {
    doc,
    blobs,
    result: {
      label: v.label,
      changes: doc.changeCount(),
      ops: doc.opCount(),
      oplogBytes: doc.export({ mode: "update" }).length,
      snapshotBytes: doc.export({ mode: "snapshot" }).length,
      wireBytes: blobs.reduce((s, b) => s + b.length, 0),
      wireBlobs: blobs.length,
      replayMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Panel cost — what the time-travel UI pays per change
// ---------------------------------------------------------------------------

/** Frontiers for a change, exactly as `TimeTravelPanel.buildTimelineData` computes them. */
function frontiersOf(change: Change) {
  return [{ peer: change.peer, counter: change.counter + change.length - 1 }];
}

interface PanelCost {
  /** `getAllChanges()` + sort, as the panel does on EVERY commit. Median of 5. */
  timelineMs: number;
  /** `checkout(frontiers)` across sampled bars. */
  checkoutMedianMs: number;
  checkoutMaxMs: number;
  bars: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

function measurePanel(doc: LoroDoc, sampleCount: number): PanelCost {
  const builds: number[] = [];
  let nodes: Change[] = [];
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    const all = doc.getAllChanges();
    const acc: Change[] = [];
    for (const peerChanges of all.values())
      for (const c of peerChanges) acc.push(c);
    acc.sort((a, b) => a.lamport - b.lamport || a.counter - b.counter);
    builds.push(performance.now() - t0);
    nodes = acc;
  }

  const step = Math.max(1, Math.floor(nodes.length / sampleCount));
  const times: number[] = [];
  for (let i = 0; i < nodes.length; i += step) {
    const f = frontiersOf(nodes[i]!);
    const s = performance.now();
    doc.checkout(f);
    times.push(performance.now() - s);
  }
  doc.checkoutToLatest();

  return {
    timelineMs: median(builds),
    checkoutMedianMs: median(times),
    checkoutMaxMs: Math.max(0, ...times),
    bars: nodes.length,
  };
}

/**
 * One compaction pass, mirroring `services/loro-service/src/compactor.ts`:
 * fresh doc -> import each stored update -> export snapshot. Re-expressed here
 * rather than imported because the real one is bound to the service's DB row
 * types; the Loro work it does is exactly these calls.
 */
function measureCompaction(blobs: Uint8Array[]): {
  ms: number;
  outBytes: number;
} {
  const t0 = performance.now();
  const fresh = new LoroDoc();
  fresh.setPeerId("2" as PeerID);
  for (const b of blobs) fresh.import(b);
  const out = fresh.export({ mode: "snapshot" });
  return { ms: performance.now() - t0, outBytes: out.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const corpusPath = arg("corpus", "");
  const corpus: string[] = corpusPath
    ? JSON.parse(await Bun.file(corpusPath).text())
    : defaultCorpus();

  const model: SessionModel = {
    cps: Number(arg("cps", String(DEFAULT_MODEL.cps))),
    sentencePause: Number(
      arg("sentence-pause", String(DEFAULT_MODEL.sentencePause)),
    ),
    blockPause: Number(arg("block-pause", String(DEFAULT_MODEL.blockPause))),
    stintPause: Number(arg("stint-pause", String(DEFAULT_MODEL.stintPause))),
    stintBlocks: Number(arg("stint-blocks", String(DEFAULT_MODEL.stintBlocks))),
    sessions: Number(arg("sessions", String(DEFAULT_MODEL.sessions))),
    sessionGapHours: Number(
      arg("session-gap", String(DEFAULT_MODEL.sessionGapHours)),
    ),
  };
  const intervals = arg("intervals", "5,30,60,300").split(",").map(Number);

  const strokes = buildSession(corpus, model);
  const chars = corpus.reduce((s, b) => s + b.length, 0) * model.sessions;
  const spanSec = strokes[strokes.length - 1]!.timestamp - T0;
  const active = activeSeconds(strokes);

  const variants: Variant[] = [
    { label: "shipped (no stamp)", interval: null, stamp: false },
    {
      label: `default ${DEFAULT_MERGE_INTERVAL}s`,
      interval: null,
      stamp: true,
    },
    ...intervals.map((i) => ({ label: `${i}s`, interval: i, stamp: true })),
  ];

  const runs: RunResult[] = [];
  const panels: PanelCost[] = [];
  const compactions: { ms: number; outBytes: number }[] = [];

  for (const v of variants) {
    const r = replay(strokes, v);
    runs.push(r.result);
    panels.push(measurePanel(r.doc, 12));
    compactions.push(measureCompaction(r.blobs));
  }

  const report = {
    corpus: {
      source: corpusPath || "synthetic (shape of nd_ppnrr0hw78m)",
      blocks: corpus.length,
      chars,
    },
    model,
    session: {
      transactions: strokes.length,
      spanSeconds: spanSec,
      spanHuman: `${Math.floor(spanSec / 3600)}h${String(Math.floor((spanSec % 3600) / 60)).padStart(2, "0")}m`,
      activeSeconds: active,
    },
    runs,
    panels,
    compactions,
  };

  if (has("json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const kb = (n: number) => (n / 1024).toFixed(1);
  const base = runs[0]!;
  console.log(
    `corpus   ${report.corpus.source} — ${corpus.length} blocks x ${model.sessions} session(s), ${chars} chars`,
  );
  console.log(
    `session  ${strokes.length} transactions over ${report.session.spanHuman} wall clock, ${active}s of it active`,
  );
  console.log(
    `model    ${model.cps} cps, ${model.sentencePause}s sentence, ${model.blockPause}s block, ${model.stintPause}s every ${model.stintBlocks} blocks, ${model.sessions} session(s) ${model.sessionGapHours}h apart`,
  );
  console.log(
    `wire     ${base.wireBlobs} update blobs, ${kb(base.wireBytes)} KB — one blob per commit, identical at every interval\n`,
  );
  console.log(
    "interval             bars     ops   oplog KB  snapshot KB   snap Δ   timeline ms   checkout ms p50/max   compact ms",
  );
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const p = panels[i]!;
    const c = compactions[i]!;
    const delta = r.snapshotBytes - base.snapshotBytes;
    console.log(
      r.label.padEnd(20) +
        String(p.bars).padStart(5) +
        String(r.ops).padStart(8) +
        kb(r.oplogBytes).padStart(11) +
        kb(r.snapshotBytes).padStart(13) +
        `${delta >= 0 ? "+" : ""}${kb(delta)}`.padStart(9) +
        p.timelineMs.toFixed(2).padStart(14) +
        `${p.checkoutMedianMs.toFixed(1)}/${p.checkoutMaxMs.toFixed(1)}`.padStart(
          20,
        ) +
        c.ms.toFixed(0).padStart(13),
    );
  }
  console.log(
    "\nA bar covers at most `interval` seconds of WALL CLOCK from its first commit, so a",
  );
  console.log(
    `pause inside the window burns capacity: bars run ahead of activeSeconds/interval.`,
  );
  console.log(
    `Active editing per bar here: ${runs
      .slice(2)
      .map((r) => `${r.label} ${(active / r.changes).toFixed(1)}s`)
      .join(", ")}`,
  );
}

main();

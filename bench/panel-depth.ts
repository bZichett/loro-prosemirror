/**
 * Panel cost vs. history depth — does bar count hurt the time-travel UI?
 *
 * `change-granularity.ts` answers "how many bars does an interval produce".
 * This answers "what does a bar cost once there are a lot of them", which is
 * the other half of the interval decision: `TimeTravelPanel` rebuilds its whole
 * timeline from `getAllChanges()` on EVERY commit (its `subscribeLocalUpdates`
 * handler), renders one DOM bar per change, and calls `checkout(frontiers)` per
 * click.
 *
 * The op stream is held constant and only the change count varies, so the
 * numbers isolate the cost of splitting rather than the cost of the document.
 *
 *   bun bench/panel-depth.ts
 *   bun bench/panel-depth.ts --ops 30000 --bars 1,10,100,1000,10000 --json
 */
import { LoroDoc, LoroText } from "loro-crdt";
import type { Change, PeerID } from "loro-crdt";

const T0 = 1_767_225_600;

/** Frontiers for a change, exactly as `TimeTravelPanel.buildTimelineData` computes them. */
function frontiersOf(change: Change) {
  return [{ peer: change.peer, counter: change.counter + change.length - 1 }];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

/** A doc of `ops` text inserts split into exactly `bars` changes. */
function build(ops: number, bars: number): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId("1" as PeerID);
  doc.setRecordTimestamp(true);
  // 0 keeps every distinct-second commit its own change; the explicit
  // per-commit timestamp below is what actually forces the split.
  doc.setChangeMergeInterval(0);

  const text = doc.getMap("tree").setContainer("body", new LoroText());
  const perBar = Math.max(1, Math.floor(ops / bars));
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < perBar; i++) text.insert(text.length, "x");
    doc.commit({ timestamp: T0 + b, origin: "local", message: "local" });
  }
  return doc;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function main() {
  const ops = Number(arg("ops", "30000"));
  const barCounts = arg("bars", "1,10,100,1000,10000").split(",").map(Number);
  const rows: Record<string, number>[] = [];

  for (const bars of barCounts) {
    const doc = build(ops, bars);

    const builds: number[] = [];
    let nodes: Change[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      const acc: Change[] = [];
      for (const peerChanges of doc.getAllChanges().values())
        for (const c of peerChanges) acc.push(c);
      acc.sort((a, b) => a.lamport - b.lamport || a.counter - b.counter);
      builds.push(performance.now() - t0);
      nodes = acc;
    }

    // The panel rebuilds unconditionally on every commit, but at a 60s merge
    // interval a keystroke almost never creates a change. `changeCount()` is
    // the cheap guard that would let it skip — measure whether it is actually
    // cheap, or just as expensive as the rebuild it is meant to avoid.
    const counts: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      doc.changeCount();
      counts.push(performance.now() - t0);
    }

    const step = Math.max(1, Math.floor(nodes.length / 20));
    const checkouts: number[] = [];
    for (let i = 0; i < nodes.length; i += step) {
      const f = frontiersOf(nodes[i]!);
      const s = performance.now();
      doc.checkout(f);
      checkouts.push(performance.now() - s);
    }
    doc.checkoutToLatest();

    rows.push({
      bars: nodes.length,
      ops: doc.opCount(),
      oplogKB: doc.export({ mode: "update" }).length / 1024,
      snapshotKB: doc.export({ mode: "snapshot" }).length / 1024,
      timelineMs: median(builds),
      changeCountMs: median(counts),
      checkoutP50: median(checkouts),
      checkoutMax: Math.max(0, ...checkouts),
    });
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ops, rows }, null, 2));
    return;
  }
  console.log(
    `op stream held at ~${ops} inserts; only the change count varies\n`,
  );
  console.log(
    "   bars     ops   oplog KB  snapshot KB   timeline ms   changeCount ms   checkout ms p50/max",
  );
  for (const r of rows) {
    console.log(
      String(r.bars).padStart(7) +
        String(r.ops).padStart(8) +
        r.oplogKB!.toFixed(1).padStart(11) +
        r.snapshotKB!.toFixed(1).padStart(13) +
        r.timelineMs!.toFixed(2).padStart(14) +
        r.changeCountMs!.toFixed(3).padStart(17) +
        `${r.checkoutP50!.toFixed(1)}/${r.checkoutMax!.toFixed(1)}`.padStart(
          22,
        ),
    );
  }
}

main();

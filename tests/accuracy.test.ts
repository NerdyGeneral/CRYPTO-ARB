import assert from "node:assert/strict";
import { test } from "node:test";
import { accuracy, addReplay, emptyTally, histogram, verdictSummary } from "../lib/accuracy";

const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test("accuracy from replayed trades", () => {
  const t = emptyTally();
  addReplay(t, "filled", 0.5, 0.45);
  addReplay(t, "partial", 0.4, -0.2);
  addReplay(t, "missed", 0.3, 0);
  addReplay(t, "filled", 0.6, 0.7);
  const a = accuracy(t);
  assert.equal(a.replays, 4);
  close(a.wrongPct, 50);
  close(a.missedPct, 25);
  close(a.lossPct, 25);
  close(a.meanError, (0.45 - 0.2 + 0 + 0.7 - (0.5 + 0.4 + 0.3 + 0.6)) / 4);
  close(a.meanAbsError, (0.05 + 0.6 + 0.3 + 0.1) / 4);
  close(a.capturePct, (0.95 / 1.8) * 100);
  assert.equal(accuracy(emptyTally()).wrongPct, null);
});

test("histogram bins keep zero on an edge and count every value", () => {
  const values = [-0.62, -0.3, -0.05, 0.02, 0.04, 0.11, 0.33];
  const bins = histogram(values);
  assert.ok(bins.length <= 12 && bins.length > 1);
  assert.equal(bins.reduce((n, b) => n + b.count, 0), values.length);
  assert.ok(bins.some((b) => Math.abs(b.from) < 1e-12), "a bin starts at zero");
  for (const v of values) assert.equal(bins.filter((b) => v >= b.from - 1e-12 && v < b.to + 1e-12).length >= 1, true);
  assert.deepEqual(histogram([]), []);
  assert.equal(histogram([0, 0]).reduce((n, b) => n + b.count, 0), 2);
});

test("verdict shares: suspects that look real, traded routes with a barrier", () => {
  const s = verdictSummary([
    { group: "suspect", kind: "different-tokens" }, { group: "suspect", kind: "no-barrier-found" },
    { group: "suspect", kind: "transfers-blocked" }, { group: "suspect", kind: "unverified" },
    { group: "traded", kind: "no-barrier-found" }, { group: "traded", kind: "no-barrier-found" }, { group: "traded", kind: "transfers-blocked" },
  ]);
  close(s.suspectRealPct, 100 / 3);
  close(s.tradedBlockedPct, 100 / 3);
  assert.equal(s.suspect.unverified, 1);
  assert.equal(verdictSummary([]).suspectRealPct, null);
});

import type { VerdictKind } from "./verify";

// How far the paper estimates are from what the replayed (shadow) trades would really have made, and how
// often the suspect-gap rule is too cautious or not cautious enough.

export type ShadowTally = { filled: number; partial: number; missed: number; expected: number; realized: number; absError: number; losses: number };

export const emptyTally = (): ShadowTally => ({ filled: 0, partial: 0, missed: 0, expected: 0, realized: 0, absError: 0, losses: 0 });

// Adds one replayed trade: `expected` is the paper net, `realized` the replayed net.
export function addReplay(tally: ShadowTally, outcome: "filled" | "partial" | "missed", expected: number, realized: number) {
  tally[outcome]++;
  tally.expected += expected;
  tally.realized += realized;
  tally.absError += Math.abs(realized - expected);
  if (expected > 0 && realized < 0) tally.losses++;
}

export type Accuracy = {
  replays: number;
  // Share of paper trades that would not have gone through as seen: one side only, or nothing at all.
  wrongPct: number | null;
  missedPct: number | null;
  partialPct: number | null;
  // Average of (realistic − paper) per trade; negative means the paper estimate is too optimistic.
  meanError: number | null;
  meanAbsError: number | null;
  // Share of trades predicted to make money that would have lost money.
  lossPct: number | null;
  // Realistic profit as a share of paper profit.
  capturePct: number | null;
};

export function accuracy(t: ShadowTally): Accuracy {
  const replays = t.filled + t.partial + t.missed;
  const share = (n: number) => replays ? (n / replays) * 100 : null;
  return {
    replays,
    wrongPct: share(t.partial + t.missed), missedPct: share(t.missed), partialPct: share(t.partial),
    meanError: replays ? (t.realized - t.expected) / replays : null,
    meanAbsError: replays ? t.absError / replays : null,
    lossPct: share(t.losses),
    capturePct: t.expected > 0 ? (t.realized / t.expected) * 100 : null,
  };
}

export type Bin = { from: number; to: number; count: number };

// Equal-width bins on a round step, with zero always on a bin edge so over- and under-estimates stay apart.
export function histogram(values: number[], maxBins = 12): Bin[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [];
  const lo = Math.min(0, ...finite), hi = Math.max(0, ...finite);
  const span = hi - lo || 1;
  const raw = span / maxBins, power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => span / s <= maxBins) ?? 10 * power;
  const start = Math.floor(lo / step) * step;
  const count = Math.max(1, Math.ceil((hi - start) / step + 1e-9));
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({ from: start + i * step, to: start + (i + 1) * step, count: 0 }));
  for (const value of finite) bins[Math.min(count - 1, Math.floor((value - start) / step + 1e-9))].count++;
  return bins;
}

// Verdicts for suspect gaps (above the max gap) and for routes that were paper-traded (under it).
export type VerdictGroup = "suspect" | "traded";
export type VerdictCounts = Record<VerdictKind, number>;
export const verdictKinds: VerdictKind[] = ["different-tokens", "transfers-blocked", "price-anomaly", "no-barrier-found", "unverified"];
const barrierKinds: VerdictKind[] = ["different-tokens", "transfers-blocked", "price-anomaly"];

export function verdictSummary(latest: Iterable<{ group: VerdictGroup; kind: VerdictKind }>) {
  const counts = { suspect: zeroCounts(), traded: zeroCounts() };
  for (const { group, kind } of latest) counts[group][kind]++;
  const decided = (c: VerdictCounts) => verdictKinds.filter((k) => k !== "unverified").reduce((sum, k) => sum + c[k], 0);
  const barriers = (c: VerdictCounts) => barrierKinds.reduce((sum, k) => sum + c[k], 0);
  const share = (n: number, of: number) => of ? (n / of) * 100 : null;
  return {
    suspect: counts.suspect, traded: counts.traded,
    // Of the suspects that could be checked, how many showed nothing stopping the trade: the rule was too cautious.
    suspectRealPct: share(counts.suspect["no-barrier-found"], decided(counts.suspect)),
    // Of the traded routes that could be checked, how many had a barrier anyway: the rule was not cautious enough.
    tradedBlockedPct: share(barriers(counts.traded), decided(counts.traded)),
  };
}

function zeroCounts(): VerdictCounts {
  return { "different-tokens": 0, "transfers-blocked": 0, "price-anomaly": 0, "no-barrier-found": 0, unverified: 0 };
}

import type { Leg } from "./opportunities";

export type Sent<T> = { leg: Leg; startedAt: number; doneAt: number; result: T | null; error: string | null };

// Starts every leg's send before waiting on any, so no leg waits for another, and collects each outcome
// (including failures) without one failed leg hiding the others. The paper replay goes through this, as
// real orders would.
export function sendInParallel<T>(legs: Leg[], send: (leg: Leg, index: number) => Promise<T>, clock = () => performance.now()): Promise<Sent<T>[]> {
  return Promise.all(legs.map((leg, index) => {
    const startedAt = clock();
    let pending: Promise<T>;
    try { pending = send(leg, index); } catch (error) { pending = Promise.reject(error); }
    return pending.then(
      (result) => ({ leg, startedAt, doneAt: clock(), result, error: null }),
      (error: unknown) => ({ leg, startedAt, doneAt: clock(), result: null, error: error instanceof Error ? error.message : String(error) }),
    );
  }));
}

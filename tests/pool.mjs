/*
 * A bounded worker pool for the suite runner (T94).
 *
 * Extracted rather than inlined into `run.mjs` so it can be tested directly. The property that
 * needs testing is not "does it go faster" — a stopwatch shows that — but **that results come
 * back in input order however they finish**. A pool that scrambles them still looks fast while
 * attributing every failure to the wrong suite, which is a slow run plus a lie.
 */

/**
 * Runs `worker(item, index)` over `items`, at most `limit` at a time.
 *
 * Resolves with results **indexed to match `items`**, not to completion order. A worker that
 * throws yields its rejection reason in place, because one broken suite must not abandon the
 * other thirty-nine — the runner decides what a failure means, this only reports it.
 */
export const runPool = async (items, limit, worker) => {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const consume = async () => {
    while (next < items.length) {
      // Read and advance in one step: `await` below yields, and two consumers reading the same
      // index would run the same item twice and leave another never run at all.
      const index = next;
      next += 1;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = error;
      }
    }
  };

  await Promise.all(Array.from({ length: size }, () => consume()));
  return results;
};

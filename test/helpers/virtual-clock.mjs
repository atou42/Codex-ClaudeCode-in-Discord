// Deterministic virtual clock. No real timers anywhere in this file.
// advance() synchronously fires any callbacks whose deadline has passed,
// in deadline order, then registration order for ties.

export function createVirtualClock(startAt = 0) {
  let now = startAt;
  let nextId = 1;
  const pending = new Map();

  function setTimeout(fn, delayMs) {
    const id = nextId++;
    pending.set(id, { fn, deadline: now + Math.max(0, delayMs), seq: id });
    return id;
  }

  function clearTimeout(id) {
    pending.delete(id);
  }

  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let due = null;
      for (const entry of pending.values()) {
        if (entry.deadline <= target && (due === null || entry.deadline < due.deadline || (entry.deadline === due.deadline && entry.seq < due.seq))) {
          due = entry;
        }
      }
      if (!due) break;
      pending.delete(
        [...pending.entries()].find(([, v]) => v === due)[0],
      );
      now = due.deadline;
      due.fn();
    }
    now = target;
  }

  return {
    now: () => now,
    setTimeout,
    clearTimeout,
    advance,
    pendingCount: () => pending.size,
  };
}

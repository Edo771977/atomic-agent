/** One delegate call's FIFO execution ceiling, shared by its provider pools. */
export interface TaskPermit {
  readonly waitMs: number;
  release(): void;
}

export function createTaskPermitPool(width: number): {
  acquire(signal: AbortSignal): Promise<TaskPermit | undefined>;
} {
  let active = 0;
  interface Waiter {
    signal: AbortSignal;
    started: number;
    resolve: (permit: TaskPermit | undefined) => void;
    abort: () => void;
  }
  const queue: Waiter[] = [];
  const permit = (waitMs: number): TaskPermit => {
    active++;
    let released = false;
    return { waitMs, release: () => {
      if (released) return;
      released = true;
      active--;
      while (active < width && queue.length > 0) {
        const next = queue.shift()!;
        next.signal.removeEventListener("abort", next.abort);
        next.resolve(next.signal.aborted ? undefined : permit(Math.max(0, Date.now() - next.started)));
      }
    } };
  };
  return { acquire: (signal) => {
    if (signal.aborted) return Promise.resolve(undefined);
    if (active < width && queue.length === 0) return Promise.resolve(permit(0));
    return new Promise((resolve) => {
      const waiter: Waiter = { signal, started: Date.now(), resolve, abort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        resolve(undefined);
      } };
      queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  } };
}

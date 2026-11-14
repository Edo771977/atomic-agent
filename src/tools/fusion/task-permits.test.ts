import { describe, expect, it } from "vitest";
import { createTaskPermitPool } from "./task-permits.js";

describe("task permits", () => {
  it("removes an aborted waiter and preserves FIFO without losing capacity", async () => {
    const pool = createTaskPermitPool(1);
    const controller = new AbortController();
    const signal = new AbortController().signal;
    const first = (await pool.acquire(signal))!;
    const cancelled = pool.acquire(controller.signal);
    let thirdStarted = false;
    const third = pool.acquire(signal).then((permit) => { thirdStarted = true; return permit!; });
    controller.abort();
    expect(await cancelled).toBeUndefined();
    expect(thirdStarted).toBe(false);
    first.release();
    const thirdPermit = await third;
    let fourthStarted = false;
    const fourth = pool.acquire(signal).then((permit) => { fourthStarted = true; return permit!; });
    first.release();
    await Promise.resolve();
    expect(fourthStarted).toBe(false);
    thirdPermit.release();
    (await fourth).release();
  });
});

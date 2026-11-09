import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForegroundScheduler } from '../src/scheduler';

afterEach(() => {
  vi.useRealTimers();
});

describe('ForegroundScheduler', () => {
  it('pauses while inactive and runs immediately when visibility resumes', async () => {
    vi.useFakeTimers();
    let active = true;
    let runs = 0;
    const scheduler = new ForegroundScheduler(() => active, async () => { runs++; }, () => undefined);
    scheduler.configure(true, 5);

    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    active = false;
    scheduler.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);

    active = true;
    scheduler.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    scheduler.stop();
  });

  it('uses a newly configured interval for subsequent completion-based ticks', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new ForegroundScheduler(() => true, async () => { runs++; }, () => undefined);
    scheduler.configure(true, 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    scheduler.configure(true, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(3);
    scheduler.stop();
  });

  it('does not overlap work when visibility changes while a run is still in flight', async () => {
    vi.useFakeTimers();
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const resolveRuns: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((resolve) => {
      activeRuns++;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      resolveRuns.push(() => {
        activeRuns--;
        resolve();
      });
    }));
    const scheduler = new ForegroundScheduler(() => true, run, () => undefined);
    scheduler.configure(true, 30);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);

    try {
      expect(run).toHaveBeenCalledTimes(1);
      expect(maxActiveRuns).toBe(1);
    } finally {
      scheduler.stop();
      for (const resolve of resolveRuns) resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('cancels scheduled work when disabled and does not restart on visibility events', async () => {
    vi.useFakeTimers();
    let active = true;
    let runs = 0;
    const scheduler = new ForegroundScheduler(() => active, async () => { runs++; }, () => undefined);
    scheduler.configure(true, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    scheduler.configure(false, 1);
    active = true;
    scheduler.visibilityChanged();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
    scheduler.stop();
  });

  it('splits delays longer than the signed 32-bit timer limit', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new ForegroundScheduler(() => true, async () => { runs++; }, () => undefined);
    const intervalMs = 30 * 24 * 60 * 60 * 1000;
    const firstChunk = 2_147_483_647;
    const secondChunk = intervalMs - firstChunk;
    scheduler.configure(true, intervalMs / 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(firstChunk - 1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(secondChunk - 1);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(2);
    scheduler.stop();
  });
});

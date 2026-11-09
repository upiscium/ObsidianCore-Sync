/** Completion-based scheduling avoids overlapping work and catch-up bursts after suspension. */
export class ForegroundScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private generation = 0;
  private running = false;
  private rerun = false;
  constructor(
    private readonly active: () => boolean,
    private readonly run: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
    private intervalSeconds = 30,
  ) {}
  configure(enabled: boolean, intervalSeconds: number): void {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400 * 30) throw new Error('同期間隔は1秒〜30日で指定してください。');
    this.stop();
    this.intervalSeconds = intervalSeconds;
    this.stopped = !enabled;
    if (enabled && this.active()) {
      if (this.running) this.rerun = true;
      else this.schedule(0);
    }
  }
  visibilityChanged(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
    if (!this.stopped && this.active()) {
      if (this.running) this.rerun = true;
      else this.schedule(0);
    }
  }
  stop(): void {
    this.stopped = true;
    this.rerun = false;
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(delay: number): void {
    const generation = this.generation;
    // setTimeout has a signed 32-bit delay; long user-selected intervals are split.
    const chunk = Math.min(delay, 2_147_483_647);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || generation !== this.generation || !this.active()) return;
      if (delay > chunk) { this.schedule(delay - chunk); return; }
      void this.tick(generation);
    }, chunk);
  }
  private async tick(generation: number): Promise<void> {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    try { await this.run(); } catch (error) {
      try { this.onError(error); } catch { /* An error reporter must not break scheduling. */ }
    }
    finally {
      this.running = false;
      const immediate = this.rerun || generation !== this.generation;
      this.rerun = false;
      if (!this.stopped && this.active()) this.schedule(immediate ? 0 : this.intervalSeconds * 1000);
    }
  }
}

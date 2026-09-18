import type { Clock } from '../domain/Clock.js';
export type Fetch = typeof fetch;
/** Shared sliding-window limiter. Serializes scheduling, not application domain logic. */
export class HttpClient {
  private starts: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private clock: Clock,
    private limit = 55,
    private transport: Fetch = fetch,
  ) {}
  private async reserve(): Promise<void> {
    const turn = this.queue.then(async () => {
      let now = this.clock.now().getTime();
      this.starts = this.starts.filter((t) => t > now - 60000);
      if (this.starts.length >= this.limit) {
        await this.clock.sleep(Math.max(1, (this.starts[0] ?? now) + 60001 - now));
        now = this.clock.now().getTime();
        this.starts = this.starts.filter((t) => t > now - 60000);
      }
      this.starts.push(now);
    });
    this.queue = turn.catch(() => undefined);
    await turn;
  }
  async json(url: string, init: RequestInit = {}, timeout = 20000): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reserve();
      const response = await this.transport(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (response.ok) return response.json() as Promise<unknown>;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = Number(response.headers.get('retry-after'));
        await this.clock.sleep(
          Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 60000) : 1000 * 2 ** attempt,
        );
        continue;
      }
      const errorBody = await response.text();
      let detail = '';
      try {
        const parsed: unknown = JSON.parse(errorBody);
        if (
          parsed &&
          typeof parsed === 'object' &&
          'error' in parsed &&
          parsed.error &&
          typeof parsed.error === 'object' &&
          'message' in parsed.error &&
          typeof parsed.error.message === 'string'
        )
          detail = `: ${parsed.error.message.slice(0, 500)}`;
      } catch {
        // Providers are allowed to return a non-JSON failure response.
      }
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}${detail}`);
    }
    throw new Error('HTTP retries exhausted');
  }
}

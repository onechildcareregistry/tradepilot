import { z } from 'zod';
import type { Clock } from '../domain/Clock.js';
import type { Bar, Quote } from '../domain/models.js';
import type { MarketDataProvider } from './MarketDataProvider.js';
import { StreamPriceBars } from './StreamPriceBars.js';
export interface TradeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}
export type SocketFactory = (url: string) => TradeSocket;
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), msg: z.string().optional() }),
  z.object({
    type: z.literal('trade'),
    data: z.array(
      z.object({
        s: z.string(),
        p: z.number().positive().finite(),
        t: z.number().int().positive(),
        v: z.number().nonnegative().optional(),
      }),
    ),
  }),
]);
/** One outbound socket; no REST fallback, external orders, or public webhook. */
export class FinnhubMarketDataProvider implements MarketDataProvider {
  readonly transport = 'stream' as const;
  readonly source = 'finnhub:trades';
  readonly coverage =
    'Finnhub streamed last trades; observed minute ranges; no spread or consolidated-volume modeling';
  private socket?: TradeSocket;
  private symbols: string[] = [];
  private queue: Quote[] = [];
  private latest = new Map<string, Quote>();
  private bars = new StreamPriceBars();
  private lastMessageAt = 0;
  private nextConnectAt = 0;
  private failures = 0;
  private issue = 'stream-connecting';
  constructor(
    private key: string,
    private clock: Clock,
    private factory: SocketFactory = (url) => new WebSocket(url),
  ) {}
  private disconnect(issue: string): void {
    const socket = this.socket;
    this.socket = undefined;
    this.issue = issue;
    this.queue = [];
    this.latest.clear();
    this.bars.disconnected();
    this.nextConnectAt =
      this.clock.now().getTime() + Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    socket?.close();
  }
  private connect(symbols: string[]): void {
    const desired = [...new Set(symbols)].sort();
    if (JSON.stringify(desired) !== JSON.stringify(this.symbols)) {
      this.close();
      this.symbols = desired;
    }
    const now = this.clock.now().getTime();
    if (this.socket && now - this.lastMessageAt > 60000) this.disconnect('stream-timeout');
    if (this.socket || !desired.length || now < this.nextConnectAt) return;
    const url = new URL('wss://ws.finnhub.io');
    url.searchParams.set('token', this.key);
    let socket: TradeSocket;
    try {
      socket = this.factory(url.toString());
    } catch {
      this.disconnect('stream-connection-failed');
      return;
    }
    this.socket = socket;
    this.lastMessageAt = now;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.clock.now().getTime();
      this.bars.connected(this.lastMessageAt);
      this.issue = '';
      try {
        for (const symbol of this.symbols)
          socket.send(JSON.stringify({ type: 'subscribe', symbol }));
      } catch {
        this.disconnect('stream-subscription-failed');
      }
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      try {
        const raw: unknown = (event as MessageEvent<unknown>).data;
        if (typeof raw !== 'string' || raw.length > 2_000_000) throw new Error('Invalid message');
        const message = messageSchema.parse(JSON.parse(raw) as unknown);
        this.lastMessageAt = this.clock.now().getTime();
        if (message.type === 'error') {
          this.disconnect('stream-provider-error');
          return;
        }
        if (message.type !== 'trade') return;
        for (const trade of message.data.sort((a, b) => a.t - b.t)) {
          if (!this.symbols.includes(trade.s)) continue;
          const age = this.lastMessageAt - trade.t;
          if (age < 0 || age > 15000) continue;
          const timestamp = new Date(trade.t).toISOString();
          const previous = this.latest.get(trade.s);
          // Without an exchange trade ID, identical timestamps are conservatively coalesced.
          if (previous && timestamp <= previous.timestamp) continue;
          const quote: Quote = {
            symbol: trade.s,
            lastPrice: String(trade.p),
            timestamp,
            receivedAt: this.clock.now().toISOString(),
            source: this.source,
            coverage: this.coverage,
          };
          this.latest.set(trade.s, quote);
          this.bars.observe(quote);
          this.queue.push(quote);
          this.failures = 0;
          if (this.queue.length > 10000) {
            this.disconnect('stream-buffer-overflow');
            return;
          }
        }
      } catch {
        this.disconnect('stream-invalid-message');
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.disconnect('stream-disconnected');
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.disconnect('stream-connection-failed');
    });
  }
  health(symbols: string[]): string | undefined {
    if (!this.socket || this.socket.readyState !== 1 || this.issue)
      return this.issue || 'stream-disconnected';
    const missing = symbols.filter((symbol) => {
      const q = this.latest.get(symbol);
      return !q || this.clock.now().getTime() - Date.parse(q.timestamp) > 15000;
    });
    return missing.length ? `partial-or-stale-data:${missing.join(',')}` : undefined;
  }
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    this.connect(symbols);
    if (!this.socket || this.socket.readyState !== 1)
      throw new Error(this.issue || 'stream-connecting');
    const now = this.clock.now().getTime();
    const quotes = this.queue.filter((q) => now - Date.parse(q.timestamp) <= 15000);
    this.queue = [];
    return quotes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  async getBars(symbols: string[], start: string, end: string): Promise<Bar[]> {
    if (this.health(symbols)) return [];
    return this.bars.completed(symbols, start, end, this.clock.now().toISOString());
  }
  async verify(symbols: string[]): Promise<{ ok: boolean; issues: string[] }> {
    if (!symbols.length) return { ok: false, issues: ['No symbols supplied'] };
    try {
      const deadline = this.clock.now().getTime() + 30000;
      while (this.clock.now().getTime() < deadline) {
        try {
          await this.getQuotes(symbols);
        } catch {
          /* bounded connection warmup */
        }
        if (!this.health(symbols)) return { ok: true, issues: [] };
        await this.clock.sleep(250);
      }
      return {
        ok: false,
        issues: [
          `Fresh streamed trades were not verified for every symbol: ${this.health(symbols) ?? 'unknown'}`,
        ],
      };
    } finally {
      this.close();
    }
  }
  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.queue = [];
    this.latest.clear();
    this.bars.disconnected();
    this.nextConnectAt = 0;
    this.issue = 'stream-connecting';
    socket?.close();
  }
}

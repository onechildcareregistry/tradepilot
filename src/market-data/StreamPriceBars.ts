import { Decimal } from 'decimal.js';
import type { Bar, Quote } from '../domain/models.js';
/** Observed stream OHLC only; a connection gap invalidates uncommitted minutes. */
export class StreamPriceBars {
  private bars = new Map<string, Bar>();
  private sealedThrough = '';
  private connectedAt = Infinity;
  connected(at: number): void {
    this.bars.clear();
    this.sealedThrough = '';
    this.connectedAt = at;
  }
  disconnected(): void {
    this.bars.clear();
    this.connectedAt = Infinity;
  }
  observe(q: Quote): void {
    const start = Math.floor(Date.parse(q.timestamp) / 60000) * 60000;
    const end = new Date(start + 60000).toISOString();
    if (start < this.connectedAt || end <= this.sealedThrough) return;
    const key = `${q.symbol}:${start}`;
    const previous = this.bars.get(key);
    if (previous) {
      previous.high = Decimal.max(previous.high, q.lastPrice).toString();
      previous.low = Decimal.min(previous.low, q.lastPrice).toString();
      previous.close = q.lastPrice;
    } else
      this.bars.set(key, {
        symbol: q.symbol,
        start: new Date(start).toISOString(),
        end,
        open: q.lastPrice,
        high: q.lastPrice,
        low: q.lastPrice,
        close: q.lastPrice,
        volume: null,
        receivedAt: q.receivedAt,
        source: 'finnhub:stream-observed',
      });
  }
  completed(symbols: string[], start: string, end: string, receivedAt: string): Bar[] {
    const result = [...this.bars.values()]
      .filter(
        (b) =>
          symbols.includes(b.symbol) && b.start >= start && b.end <= end && b.end <= receivedAt,
      )
      .map((b) => ({ ...b, receivedAt }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.symbol.localeCompare(b.symbol));
    // No later message may revise a finalized minute or influence an earlier signal.
    const boundary = new Date(Math.floor(Date.parse(end) / 60000) * 60000).toISOString();
    if (boundary > this.sealedThrough) this.sealedThrough = boundary;
    for (const [key, b] of this.bars) if (b.end <= boundary) this.bars.delete(key);
    return result;
  }
}

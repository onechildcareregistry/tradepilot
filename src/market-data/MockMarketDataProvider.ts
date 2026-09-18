import type { Bar, Quote } from '../domain/models.js';
import type { MarketDataProvider } from './MarketDataProvider.js';
export class MockMarketDataProvider implements MarketDataProvider {
  readonly source = 'mock';
  readonly coverage = 'Synthetic deterministic fixture';
  constructor(
    private quotes: Quote[] = [],
    private bars: Bar[] = [],
  ) {}
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return structuredClone(this.quotes.filter((q) => symbols.includes(q.symbol)));
  }
  async getBars(symbols: string[], start: string, end: string): Promise<Bar[]> {
    return structuredClone(
      this.bars.filter((b) => symbols.includes(b.symbol) && b.start >= start && b.end <= end),
    );
  }
  async verify(): Promise<{ ok: boolean; issues: string[] }> {
    return { ok: true, issues: [] };
  }
}

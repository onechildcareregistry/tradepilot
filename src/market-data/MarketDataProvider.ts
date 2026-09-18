import type { Bar, Quote } from '../domain/models.js';
export interface MarketDataProvider {
  readonly transport?: 'stream' | 'poll';
  health?(symbols: string[]): string | undefined;
  diagnostics?(): unknown;
  close?(): void;
  readonly source: string;
  readonly coverage: string;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getBars(symbols: string[], start: string, end: string): Promise<Bar[]>;
  verify(symbols: string[]): Promise<{ ok: boolean; issues: string[] }>;
}

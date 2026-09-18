export interface ListingDirectory {
  eligible(symbol: string, exchange: 'NASDAQ' | 'NYSE'): Promise<boolean>;
}
/** Exchange-owned directory, read-only. Unknown security types fail closed. */
export class NasdaqListingDirectory implements ListingDirectory {
  private entries = new Map<string, 'NASDAQ' | 'NYSE'>();
  private loaded = false;
  constructor(private transport: typeof fetch = fetch) {}
  async eligible(symbol: string, exchange: 'NASDAQ' | 'NYSE'): Promise<boolean> {
    if (!this.loaded) {
      for (const file of ['nasdaqlisted.txt', 'otherlisted.txt']) {
        const response = await this.transport(
          `https://www.nasdaqtrader.com/dynamic/SymDir/${file}`,
          { signal: AbortSignal.timeout(20000) },
        );
        if (!response.ok) throw new Error('Listing directory unavailable');
        const lines = (await response.text()).split(/\r?\n/),
          header = lines.shift()?.split('|') ?? [];
        for (const line of lines) {
          const values = line.split('|'),
            row = Object.fromEntries(header.map((key, i) => [key, values[i] ?? '']));
          const name = row['Security Name'] ?? '',
            ticker = row['Symbol'] ?? row['ACT Symbol'];
          const listing =
            file === 'nasdaqlisted.txt' ? 'NASDAQ' : row['Exchange'] === 'N' ? 'NYSE' : null;
          if (
            ticker &&
            listing &&
            row['Test Issue'] === 'N' &&
            row['ETF'] === 'N' &&
            /common|ordinary/i.test(name) &&
            !/warrant|preferred|depositary|units|beneficial interest/i.test(name)
          )
            this.entries.set(ticker, listing);
        }
      }
      this.loaded = true;
    }
    return this.entries.get(symbol) === exchange;
  }
}

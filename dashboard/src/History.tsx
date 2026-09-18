import { useState } from 'react';
import type { PublicReport } from '../../src/reporting/PublicReport.js';

type Candle = PublicReport['priceHistory'][number];
const price = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const time = (s: string) =>
  new Date(s).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export function PriceChart({ candles, symbol }: { candles: Candle[]; symbol: string }) {
  if (!candles.length)
    return (
      <div className="empty-chart">
        No saved candles for {symbol} in this range. Missing prices are not estimated.
      </div>
    );
  const lo = Math.min(...candles.map((b) => b.low)),
    hi = Math.max(...candles.map((b) => b.high));
  const span = hi - lo || Math.max(lo * 0.01, 0.01);
  const begin = Date.parse(candles[0]?.start ?? ''),
    finish = Date.parse(candles.at(-1)?.end ?? '');
  const x = (at: string) => 80 + ((Date.parse(at) - begin) / Math.max(60000, finish - begin)) * 820;
  const y = (n: number) => 200 - ((n - lo) / span) * 150;
  return (
    <svg
      className="chart price-chart"
      viewBox="0 0 960 250"
      role="img"
      aria-label={`${symbol} observed one-minute OHLC candles, USD. Gaps indicate missing observations.`}
    >
      {[lo, lo + span / 2, lo + span].map((n) => (
        <g key={n}>
          <line x1="80" x2="920" y1={y(n)} y2={y(n)} stroke="#26363c" />
          <text x="70" y={y(n) + 4} textAnchor="end" fill="#91a7ae" fontSize="12">
            {price(n)}
          </text>
        </g>
      ))}
      {candles.map((b) => (
        <g key={b.start} stroke={b.close >= b.open ? '#8be2c1' : '#f0a298'}>
          <title>
            {time(b.start)} ET · Open {price(b.open)} · High {price(b.high)} · Low {price(b.low)} ·
            Close {price(b.close)}
          </title>
          <line x1={x(b.start)} x2={x(b.start)} y1={y(b.high)} y2={y(b.low)} strokeWidth="1.5" />
          <line
            x1={x(b.start) - 2}
            x2={x(b.start) + 2}
            y1={y(b.close)}
            y2={y(b.close)}
            strokeWidth="3"
          />
        </g>
      ))}
      <text x="80" y="240" fill="#91a7ae" fontSize="12">
        {time(candles[0]?.start ?? '')} ET
      </text>
      <text x="920" y="240" textAnchor="end" fill="#91a7ae" fontSize="12">
        {time(candles.at(-1)?.end ?? '')} ET
      </text>
    </svg>
  );
}
export function History({ report }: { report: PublicReport | null }) {
  const [date, setDate] = useState('');
  const [symbol, setSymbol] = useState('');
  const [range, setRange] = useState('day');
  const entries = report?.reportHistory ?? [];
  const entry = entries.find((e) => e.date === date) ?? entries[0];
  const research = entry?.research;
  const names = [
    ...(entry?.candidates.map((c) => c.symbol) ?? []),
    ...(research?.watchlist.map((c) => c.symbol) ?? []),
  ];
  const trackedSymbols = [...new Set(names)];
  const selectedSymbol = trackedSymbols.includes(symbol) ? symbol : (trackedSymbols[0] ?? '');
  const endDate = entry?.date ?? '';
  const fromDate = endDate
    ? new Date(Date.parse(`${endDate}T00:00:00Z`) - (range === 'week' ? 6 : 0) * 86400000)
        .toISOString()
        .slice(0, 10)
    : '';
  const candlesFor = (ticker: string) =>
    (report?.priceHistory ?? []).filter(
      (b) =>
        b.symbol === ticker && b.start.slice(0, 10) >= fromDate && b.start.slice(0, 10) <= endDate,
    );
  return (
    <section className="panel reports" id="history">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">RESEARCH & OBSERVED PRICES</span>
          <h2>History</h2>
        </div>
        <span className="legend">USD · New York time</span>
      </div>
      {!entry ? (
        <p className="muted">Approved reports will appear here after the first run.</p>
      ) : (
        <>
          <div className="history-controls">
            <label>
              Report date
              <select value={entry.date} onChange={(e) => setDate(e.target.value)}>
                {entries.map((e) => (
                  <option key={e.date} value={e.date}>
                    {e.date}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ticker
              <select value={selectedSymbol} onChange={(e) => setSymbol(e.target.value)}>
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {entry.candidates.some((c) => c.symbol === n)
                      ? ' · Recommended'
                      : ' · Others considered'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Price range
              <select value={range} onChange={(e) => setRange(e.target.value)}>
                <option value="day">Selected day</option>
                <option value="week">7 days ending on selected day</option>
              </select>
            </label>
          </div>
          <div className="history-summary">
            <h3>
              {trackedSymbols.length} tracked ticker{trackedSymbols.length === 1 ? '' : 's'}{' '}
              <span>Observed prices</span>
            </h3>
            <p className="muted">
              {report?.status.includes('partial') || report?.status === 'data-unavailable'
                ? `The selected report has a market-data warning (${report.status}). Only candles successfully received and saved are shown.`
                : 'Only observed minutes are plotted; gaps are not connected.'}{' '}
              Prices retained here for 30 days.
            </p>
          </div>
          <div className="history-charts">
            {trackedSymbols.map((ticker) => {
              const tickerCandles = candlesFor(ticker);
              return (
                <article className="history-chart-card" key={ticker}>
                  <div className="history-chart-heading">
                    <h3>{ticker}</h3>
                    <span className="muted">
                      {entry.candidates.some((c) => c.symbol === ticker)
                        ? 'Primary recommendation'
                        : 'Others considered · tracked only'}{' '}
                      · {tickerCandles.length} candles · {fromDate} — {endDate}
                    </span>
                  </div>
                  <PriceChart candles={tickerCandles} symbol={ticker} />
                  {tickerCandles.length > 0 && (
                    <details>
                      <summary>View candle values</summary>
                      <div className="candle-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Minute (ET)</th>
                              <th>Open</th>
                              <th>High</th>
                              <th>Low</th>
                              <th>Close</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tickerCandles.map((b) => (
                              <tr key={b.start}>
                                <td>{time(b.start)}</td>
                                <td>{price(b.open)}</td>
                                <td>{price(b.high)}</td>
                                <td>{price(b.low)}</td>
                                <td>{price(b.close)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>
          <div className="history-brief">
            <span className="eyebrow">REPORT · {entry.date}</span>
            <h3>{entry.marketRegime}</h3>
            <p className="muted">
              Market score {entry.marketRegimeScore}/100 · Generated {time(entry.generatedAt)} ET
            </p>
            <h3>Primary recommendations</h3>
            <div className="candidate-list">
              {entry.candidates.map((c) => (
                <article className="report-candidate" key={c.symbol}>
                  <span className="rank">{c.rank}</span>
                  <div>
                    <strong>{c.symbol}</strong>
                    <p>{c.catalyst}</p>
                    <small>
                      Explosion {c.explosionScore}/100 · Entry quality {c.entryQuality}/100 · Brain
                      trigger {price(c.trigger)}
                    </small>
                  </div>
                </article>
              ))}
            </div>
            <div className="others-considered">
              <h4>Others considered · tracked only</h4>
              {research?.watchlist.length ? (
                <ol>
                  {research.watchlist.map((c) => (
                    <li key={c.symbol}>
                      <b>{c.symbol}</b> · {c.watchReason} · Explosion {c.explosionScore}/100 · Entry
                      quality {c.entryQuality}/100
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No others considered available for this report.</p>
              )}
            </div>
            {research && (
              <>
                <p className="muted">
                  Model: {research.model} · Prompt: {research.promptVersion} · Brain:{' '}
                  {research.brainVersion}
                </p>
                <details>
                  <summary>Complete saved structured report</summary>
                  <pre className="research-record">{JSON.stringify(research, null, 2)}</pre>
                </details>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

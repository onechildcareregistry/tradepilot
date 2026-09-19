import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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
  const firstCandle = candles[0];
  if (!firstCandle) return null;
  const lo = Math.min(...candles.map((b) => b.low)),
    hi = Math.max(...candles.map((b) => b.high));
  const span = hi - lo || Math.max(lo * 0.01, 0.01);
  const begin = Date.parse(candles[0]?.start ?? ''),
    finish = Date.parse(candles.at(-1)?.end ?? '');
  const x = (at: string) => 80 + ((Date.parse(at) - begin) / Math.max(60000, finish - begin)) * 820;
  const y = (n: number) => 200 - ((n - lo) / span) * 150;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const nearest = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartX = 80 + ((event.clientX - bounds.left) / bounds.width) * 960;
    return candles.reduce(
      (best, candle, index) =>
        Math.abs(x(candle.start) - chartX) <
        Math.abs(x(candles[best]?.start ?? firstCandle.start) - chartX)
          ? index
          : best,
      0,
    );
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const index = nearest(event);
    setHoverIndex(index);
    if (dragging) setDragEnd(index);
  };
  const hover = hoverIndex === null ? undefined : candles[hoverIndex];
  const selectionStart = dragStart === null || dragEnd === null ? undefined : candles[dragStart];
  const selectionEnd = dragStart === null || dragEnd === null ? undefined : candles[dragEnd];
  const change = selectionStart && selectionEnd ? selectionEnd.close - selectionStart.close : 0;
  const changePercent = selectionStart ? (change / selectionStart.close) * 100 : 0;
  return (
    <div className="interactive-price-chart">
      <svg
        className="chart price-chart"
        viewBox="0 0 960 250"
        role="img"
        aria-label={`${symbol} observed one-minute OHLC candles, USD. Hover for values; drag between points to compare.`}
        onPointerMove={move}
        onPointerLeave={() => !dragging && setHoverIndex(null)}
        onPointerDown={(event) => {
          const index = nearest(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragStart(index);
          setDragEnd(index);
          setDragging(true);
          setHoverIndex(index);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
      >
        {[lo, lo + span / 2, lo + span].map((n) => (
          <g key={n}>
            <line x1="80" x2="920" y1={y(n)} y2={y(n)} stroke="#26363c" />
            <text x="70" y={y(n) + 4} textAnchor="end" fill="#91a7ae" fontSize="12">
              {price(n)}
            </text>
          </g>
        ))}
        {hover && (
          <line
            x1={x(hover.start)}
            x2={x(hover.start)}
            y1="25"
            y2="215"
            stroke="#91a7ae"
            strokeDasharray="3 3"
          />
        )}
        {selectionStart && selectionEnd && (
          <rect
            x={Math.min(x(selectionStart.start), x(selectionEnd.start))}
            y="25"
            width={Math.abs(x(selectionEnd.start) - x(selectionStart.start))}
            height="190"
            fill="#79e6c3"
            opacity="0.08"
          />
        )}
        {candles.map((b, index) => (
          <g key={b.start} stroke={b.close >= b.open ? '#8be2c1' : '#f0a298'}>
            <title>
              {time(b.start)} ET · Open {price(b.open)} · High {price(b.high)} · Low {price(b.low)}{' '}
              · Close {price(b.close)}
            </title>
            <line x1={x(b.start)} x2={x(b.start)} y1={y(b.high)} y2={y(b.low)} strokeWidth="1.5" />
            <line
              x1={x(b.start) - 2}
              x2={x(b.start) + 2}
              y1={y(b.close)}
              y2={y(b.close)}
              strokeWidth="3"
            />
            <circle
              cx={x(b.start)}
              cy={y(b.close)}
              r={hoverIndex === index ? 4 : 2}
              fill="currentColor"
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
      {hover && (
        <div className="chart-tooltip">
          <strong>{time(hover.start)} ET</strong>
          <span>
            Open {price(hover.open)} · High {price(hover.high)} · Low {price(hover.low)} · Close{' '}
            {price(hover.close)}
          </span>
        </div>
      )}
      {selectionStart && selectionEnd && (
        <div className={`chart-selection ${change >= 0 ? 'positive' : 'negative'}`}>
          Drag comparison: {time(selectionStart.start)} → {time(selectionEnd.start)} ·{' '}
          <strong>
            {change >= 0 ? '+' : ''}
            {price(change)}
          </strong>{' '}
          ({changePercent >= 0 ? '+' : ''}
          {changePercent.toFixed(2)}%)
        </div>
      )}
    </div>
  );
}
export function History({ report }: { report: PublicReport | null }) {
  const [date, setDate] = useState('');
  const [range, setRange] = useState('day');
  const entries = report?.reportHistory ?? [];
  const entry = entries.find((e) => e.date === date) ?? entries[0];
  const research = entry?.research;
  const names = [
    ...(entry?.candidates.map((c) => c.symbol) ?? []),
    ...(research?.watchlist.map((c) => c.symbol) ?? []),
  ];
  const trackedSymbols = [...new Set(names)];
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

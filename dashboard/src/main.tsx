import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { publicReportSchema, type PublicReport } from '../../src/reporting/PublicReport.js';
import './style.css';
import { History } from './History.js';
const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);
const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)}%`);
function Chart({ points }: { points: PublicReport['equityCurve'] }) {
  if (points.length < 2)
    return <div className="empty-chart">Equity history appears after the first observations.</div>;
  const values = points.map((p) => p.equity),
    lo = Math.min(...values) - 2,
    hi = Math.max(...values) + 2;
  const coords = points
    .map(
      (p, i) =>
        `${40 + (i / (points.length - 1)) * 920},${220 - ((p.equity - lo) / (hi - lo)) * 185}`,
    )
    .join(' ');
  return (
    <svg
      className="chart"
      viewBox="0 0 1000 260"
      role="img"
      aria-label={`Equity history from ${usd(values[0] ?? 0)} to ${usd(values.at(-1) ?? 0)}`}
    >
      <defs>
        <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#73dfc0" stopOpacity=".2" />
          <stop offset="100%" stopColor="#73dfc0" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[40, 100, 160, 220].map((y) => (
        <line key={y} x1="40" x2="960" y1={y} y2={y} stroke="#233036" strokeDasharray="3 6" />
      ))}
      <polygon points={`40,230 ${coords} 960,230`} fill="url(#area)" />
      <polyline
        points={coords}
        fill="none"
        stroke="#73dfc0"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <text x="40" y="252" fill="#8c9da5" fontSize="12">
        {new Date(points[0]?.at ?? '').toLocaleString()}
      </text>
      <text x="960" y="252" textAnchor="end" fill="#8c9da5" fontSize="12">
        {new Date(points.at(-1)?.at ?? '').toLocaleString()}
      </text>
    </svg>
  );
}
function App() {
  const [report, setReport] = useState<PublicReport | null>(null),
    [error, setError] = useState<string | null>(null),
    [tick, setTick] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function refresh() {
      try {
        const configResponse = await fetch('/config.json', { signal: controller.signal });
        if (!configResponse.ok) throw new Error('Configuration unavailable');
        const config: unknown = await configResponse.json();
        if (
          !config ||
          typeof config !== 'object' ||
          !('reportUrl' in config) ||
          typeof config.reportUrl !== 'string'
        )
          throw new Error('Invalid configuration');
        const url = new URL(config.reportUrl, location.origin);
        if (
          url.origin !== location.origin &&
          !(url.protocol === 'https:' && url.hostname.endsWith('.blob.core.windows.net'))
        )
          throw new Error('Invalid report origin');
        const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
        if (!response.ok) throw new Error('Report not yet published');
        const next = publicReportSchema.parse(await response.json());
        if (active) {
          setReport(next);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Report unavailable');
      }
      if (active) setTick(Date.now());
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 60000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const stale = report && !report.fixture && tick - Date.parse(report.generatedAt) > 10 * 60000;
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/" aria-label="TradePilot home">
          <span className="brand-icon">↗</span>TradePilot<span className="version">V1</span>
        </a>
        <div className="nav-label">OBSERVATORY</div>
        <a className="nav active" href="#overview">
          <span>◫</span> Overview
        </a>
        <a className="nav" href="#performance">
          <span>⌁</span> Performance
        </a>
        <a className="nav" href="#history">
          <span>▤</span> History
        </a>
        <a className="nav" href="#method">
          <span>ⓘ</span> Method & coverage
        </a>
        <div className="sidebar-bottom">
          <span className="status-dot" /> MONOPOLY MODE<p>Research. Observe. Measure.</p>
          <small>No real money. No live orders.</small>
        </div>
      </aside>
      <main id="overview">
        <header>
          <span className="breadcrumb">EXPERIMENT / OVERVIEW</span>
          <span className="readonly">◉ &nbsp; Public · Read only</span>
        </header>
        <section className="heading">
          <div>
            <div className="eyebrow">THE TRADING EXPERIMENT</div>
            <h1>
              Small capital.
              <br />
              <span>Measurable decisions.</span>
            </h1>
            <p>An open view into a rules-based, AI-assisted simulation.</p>
          </div>
          <div className="session">
            <span className="label">LATEST SESSION</span>
            <strong>{report?.sessionDate ?? 'Awaiting first run'}</strong>
            <span className="badge">
              {report?.fixture
                ? 'SYNTHETIC DEMO'
                : (report?.status.replaceAll('-', ' ').toUpperCase() ?? 'WAITING')}
            </span>
          </div>
        </section>
        {error && (
          <div className="notice" role="status">
            {report ? 'Last available report retained. ' : ''}
            {error}. The dashboard will retry automatically.
          </div>
        )}
        {stale && (
          <div className="notice" role="status">
            No recent report. Last published {new Date(report.generatedAt).toLocaleString()}. This
            may be outside market hours.
          </div>
        )}
        {report?.fixture && (
          <div className="demo-note">
            DEMO DATA <span>This is a deterministic fixture, not a live trading result.</span>
          </div>
        )}
        <section className="metrics" aria-label="Portfolio metrics">
          {[
            {
              label: 'SIMULATED EQUITY',
              value: report ? usd(report.metrics.equity) : '—',
              note: 'Starting capital · $5,000.00',
              accent: true,
            },
            {
              label: 'SESSION P&L',
              value: report ? usd(report.metrics.dailyPnl) : '—',
              note: report
                ? `${pct(report.metrics.dailyReturn)} session return`
                : 'Awaiting session',
            },
            {
              label: 'CUMULATIVE P&L',
              value: report ? usd(report.metrics.cumulativePnl) : '—',
              note: report
                ? `${pct(report.metrics.cumulativeReturn)} total return`
                : 'Since inception',
            },
            {
              label: 'MAX DRAWDOWN',
              value: report ? pct(report.metrics.maximumDrawdown) : '—',
              note: 'Observed equity peak to trough',
            },
          ].map((m) => (
            <article className={`metric ${m.accent ? 'accent' : ''}`} key={m.label}>
              <span className="label">{m.label}</span>
              <strong>{m.value}</strong>
              <small>{m.note}</small>
            </article>
          ))}
        </section>
        <section className="panel" id="performance">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">PORTFOLIO TRAJECTORY</span>
              <h2>Equity over time</h2>
            </div>
            <span className="legend">
              <i /> Simulated equity · USD
            </span>
          </div>
          <Chart points={report?.equityCurve ?? []} />
          <div className="chart-footer">
            <span>
              Closed trades <b>{report?.metrics.tradeCount ?? '—'}</b>
            </span>
            <span>
              Win rate <b>{report ? pct(report.metrics.winRate) : '—'}</b>
            </span>
            <span>
              Realized P&L <b>{report ? usd(report.metrics.realizedPnl) : '—'}</b>
            </span>
          </div>
        </section>
        <section className="lower-grid">
          <article className="panel">
            <span className="eyebrow">SESSION LEDGER</span>
            <h2>Daily performance</h2>
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Status</th>
                  <th>P&L</th>
                </tr>
              </thead>
              <tbody>
                {report?.dailyPerformance
                  .slice(-7)
                  .reverse()
                  .map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>
                        <span className="table-status">{d.status}</span>
                      </td>
                      <td>{d.pnl === null ? '—' : usd(d.pnl)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!report?.dailyPerformance.length && (
              <p className="muted">No completed sessions yet.</p>
            )}
          </article>
          <article className="panel">
            <span className="eyebrow">DECISION BREAKDOWN</span>
            <h2>Performance by candidate rank</h2>
            {report?.byRank.length ? (
              report.byRank.map((r) => (
                <div className="rank-row" key={r.label}>
                  <span className="rank">{r.label}</span>
                  <div>
                    <strong>Candidate rank {r.label}</strong>
                    <small>
                      {r.tradeCount} closed trade{r.tradeCount === 1 ? '' : 's'} · {pct(r.winRate)}{' '}
                      win rate
                    </small>
                  </div>
                  <b>{usd(r.pnl)}</b>
                </div>
              ))
            ) : (
              <p className="muted">Rank comparisons appear after closed trades.</p>
            )}
            <div className="setup">
              {report?.bySetup.map((s) => (
                <div key={s.label}>
                  <span>{s.label.replaceAll('_', ' ')}</span>
                  <b>{usd(s.pnl)}</b>
                </div>
              ))}
            </div>
          </article>
        </section>
        <History report={report} />
        <section className="panel reports" id="reports">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DAILY RESEARCH</span>
              <h2>Report history</h2>
            </div>
            <span className="legend">Approved reports</span>
          </div>
          {report?.reportHistory.length ? (
            <div className="report-list">
              {report.reportHistory.map((entry) => (
                <article className="report-card" key={`${entry.date}:${entry.generatedAt}`}>
                  <div className="report-card-header">
                    <div>
                      <strong>{entry.date}</strong>
                      <small>{new Date(entry.generatedAt).toLocaleString()}</small>
                    </div>
                    <span className="table-status">
                      {entry.marketRegime} · {entry.marketRegimeScore}/100
                    </span>
                  </div>
                  <div className="candidate-list">
                    {entry.candidates.map((candidate) => (
                      <div className="report-candidate" key={`${entry.date}:${candidate.symbol}`}>
                        <span className="rank">{candidate.rank}</span>
                        <div>
                          <strong>{candidate.symbol}</strong>
                          <p>{candidate.catalyst}</p>
                          <small>
                            Explosion {candidate.explosionScore} · Entry quality{' '}
                            {candidate.entryQuality} · Trigger {usd(candidate.trigger)}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">Approved daily reports will appear here after the first run.</p>
          )}
        </section>
        <section className="method" id="method">
          <div>
            <span className="eyebrow">KNOW WHAT YOU’RE MEASURING</span>
            <h2>An experiment, with its limits visible.</h2>
          </div>
          <p>
            {report?.coverage ??
              'Finnhub streamed last trades; observed minute ranges; no spread or volume modeling'}
            . Opening-range breakouts follow deterministic risk rules.{' '}
            {report?.disclaimer ?? 'Simulation only. Results do not establish profitability.'}
          </p>
        </section>
        <footer>
          <span>TradePilot / V0.2 strategy</span>
          <span>Updated {report ? new Date(report.generatedAt).toLocaleString() : '—'} · USD</span>
        </footer>
      </main>
    </div>
  );
}
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

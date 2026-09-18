import type { Bar, Quote, TradingPlan, Session } from './domain/models.js';
import type { Repository } from './persistence/Repository.js';
import { loadConfig } from './config.js';
import { UsTradingCalendar } from './domain/TradingCalendar.js';
import { MockClock } from './domain/Clock.js';
import { MockTradingBrain } from './brain/MockTradingBrain.js';
import { MorningResearchJob } from './jobs/MorningResearchJob.js';
import { TradingEngine } from './worker/TradingEngine.js';
import { MockMarketDataProvider } from './market-data/MockMarketDataProvider.js';
import { publicReport, type PublicReport } from './reporting/PublicReport.js';
export function samplePlan(session: Session): TradingPlan {
  return {
    tradingDate: session.date,
    brainVersion: 'V0.2',
    promptVersion: 'trading-brain-v0.2',
    model: 'mock',
    generatedAt: new Date(Date.parse(session.cutoffAt) + 60000).toISOString(),
    cutoffAt: session.cutoffAt,
    expiresAt: session.entryDeadline,
    marketRegime: 'Synthetic fixture; not a market assessment',
    candidates: [
      {
        rank: 1,
        symbol: 'DEMO',
        company: 'Synthetic Common Stock',
        exchange: 'NASDAQ',
        securityType: 'common_stock',
        explosionScore: 80,
        entryQuality: 75,
        catalyst: 'Synthetic test event',
        catalystSignificance: 'Fixture only',
        premarket: { price: null, changePercent: null, volume: null, exhaustionScore: null },
        marketCap: null,
        floatShares: null,
        triggerPrice: '100',
        stopConcept: 'Opening-range low',
        initialTarget: '103',
        maximumAllocation: 0.2,
        setupType: 'opening_range_breakout',
        reasoning: 'Deterministic fixture, not a recommendation',
        sources: [
          {
            url: 'https://example.com/fixture',
            title: 'Synthetic fixture',
            publishedAt: session.cutoffAt,
            retrievedAt: session.cutoffAt,
            cutoffVerified: false,
            excerpt: 'No live evidence',
          },
        ],
        confidence: 1,
        uncertainties: ['Synthetic data'],
      },
    ],
  };
}
export function quote(at: string, bid = '100.05', ask = '100.10', symbol = 'DEMO'): Quote {
  return {
    symbol,
    bid,
    ask,
    lastPrice: bid,
    timestamp: at,
    receivedAt: at,
    source: 'mock',
    coverage: 'Synthetic fixture',
  };
}
export function bar(start: string, close = '99.8', symbol = 'DEMO'): Bar {
  return {
    symbol,
    start,
    end: new Date(Date.parse(start) + 60000).toISOString(),
    open: close,
    high: Number(close) > 100 ? '100.20' : '100',
    low: Number(close) > 100 ? '100.01' : '99',
    close,
    volume: 10000,
    receivedAt: new Date(Date.parse(start) + 60000).toISOString(),
    source: 'mock',
  };
}
export async function runDemo(repo: Repository): Promise<PublicReport> {
  const calendar = new UsTradingCalendar(),
    session = calendar.session('2026-09-17');
  if (!session) throw new Error('Fixture calendar error');
  if ((await repo.read()).session)
    throw new Error(
      'Demo database already contains a run. Use a new DEMO_DB path; existing data is never reset automatically.',
    );
  const clock = new MockClock(new Date(samplePlan(session).generatedAt));
  const job = new MorningResearchJob(new MockTradingBrain(samplePlan(session)), repo, clock, {
    eligible: async () => true,
  });
  await job.run(session);
  const config = loadConfig({ TRADING_ENABLED: 'true', DATA_VERIFIED: 'true' }),
    engine = new TradingEngine(repo, config);
  await engine.start(session);
  const bars: Bar[] = [];
  for (let i = 0; i < 7; i++)
    bars.push(
      bar(new Date(Date.parse(session.open) + i * 60000).toISOString(), i < 5 ? '99.8' : '100.10'),
    );
  const provider = new MockMarketDataProvider([], bars);
  for (const b of await provider.getBars(['DEMO'], session.open, session.close)) {
    await engine.process({ type: 'quote', quote: quote(b.end) });
    await engine.process({ type: 'bar', bar: b });
  }
  for (const [offset, bid, ask] of [
    [425, '100.05', '100.10'],
    [480, '102.60', '102.65'],
    [485, '102.55', '102.60'],
  ] as const)
    await engine.process({
      type: 'quote',
      quote: quote(new Date(Date.parse(session.open) + offset * 1000).toISOString(), bid, ask),
    });
  await engine.process({ type: 'clock', at: session.close });
  return publicReport(await repo.read(), session.close, true);
}

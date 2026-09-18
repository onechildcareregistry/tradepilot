import { it, expect } from 'vitest';
import { MockClock } from '../src/domain/Clock.js';
import { UsTradingCalendar } from '../src/domain/TradingCalendar.js';
import { MemoryRepository, type Mutation } from '../src/persistence/Repository.js';
import { TradingWorker } from '../src/worker/TradingWorker.js';
import { TradingEngine } from '../src/worker/TradingEngine.js';
import { MockMarketDataProvider } from '../src/market-data/MockMarketDataProvider.js';
import { loadConfig } from '../src/config.js';
import { bar, samplePlan, quote } from '../src/demo.js';
import type { PublicReport } from '../src/reporting/PublicReport.js';
import type { Clock } from '../src/domain/Clock.js';
const calendar = new UsTradingCalendar();
const at = '2026-09-17T13:40:00.000Z';
async function repoWithPlan() {
  const repo = new MemoryRepository(),
    session = calendar.session('2026-09-17');
  if (!session) throw new Error('No session');
  await repo.transact((s) => {
    s.plans[session.date] = samplePlan(session);
  });
  return repo;
}
function oneIterationClock(stop: () => void): Clock {
  const clock = new MockClock(new Date(at));
  return {
    now: () => clock.now(),
    sleep: async (ms) => {
      await clock.sleep(ms);
      stop();
    },
  };
}
it('worker publishes observation-only state and releases its lease on shutdown', async () => {
  const repo = await repoWithPlan();
  let report: PublicReport | undefined;
  const clock = oneIterationClock(() => worker.shutdown());
  const worker: TradingWorker = new TradingWorker(
    loadConfig({}),
    repo,
    clock,
    calendar,
    new MockMarketDataProvider([quote(at)], [bar('2026-09-17T13:30:00.000Z')]),
    {
      publish: async (r) => {
        report = r;
      },
    },
  );
  await worker.run();
  expect(report?.status).toBe('observing');
  expect((await repo.read()).executions).toHaveLength(0);
  expect(await repo.acquireLease('next', 30)).toBe(true);
});
it('data outage is reported without losing state or fabricating fills', async () => {
  const repo = await repoWithPlan();
  let report: PublicReport | undefined;
  const provider = new MockMarketDataProvider();
  provider.getQuotes = async () => {
    throw new Error('provider down');
  };
  const worker: TradingWorker = new TradingWorker(
    loadConfig({}),
    repo,
    oneIterationClock(() => worker.shutdown()),
    calendar,
    provider,
    {
      publish: async (r) => {
        report = r;
      },
    },
  );
  await worker.run();
  expect(report?.status).toBe('data-unavailable');
  expect((await repo.read()).cash).toBe('5000');
  expect((await repo.read()).outbox.some((x) => x.id === 'data-failure:2026-09-17')).toBe(true);
});
it('a persistence error terminates processing rather than being swallowed as a feed outage', async () => {
  class FailingRepository extends MemoryRepository {
    override async transact<T>(fn: Mutation<T>, owner?: string): Promise<T> {
      return super.transact((s, a) => {
        const result = fn(s, a);
        if (a.some((x) => x.entity === 'MarketDataSnapshot')) throw new Error('durability lost');
        return result;
      }, owner);
    }
  }
  const repo = new FailingRepository(),
    session = calendar.session('2026-09-17');
  if (!session) throw new Error('No session');
  await repo.transact((s) => {
    s.plans[session.date] = samplePlan(session);
  });
  const worker: TradingWorker = new TradingWorker(
    loadConfig({}),
    repo,
    oneIterationClock(() => worker.shutdown()),
    calendar,
    new MockMarketDataProvider([quote(at)], [bar('2026-09-17T13:30:00.000Z')]),
    { publish: async () => undefined },
  );
  await expect(worker.run()).rejects.toThrow('durability lost');
  expect(await repo.records('MarketDataSnapshot')).toHaveLength(0);
  expect(await repo.acquireLease('next', 30)).toBe(true);
});
it('no-plan sessions issue one status notification and remain no-trade at close', async () => {
  const repo = new MemoryRepository(),
    session = calendar.session('2026-09-17');
  if (!session) throw new Error('No session');
  const engine = new TradingEngine(repo, loadConfig({}));
  await engine.start(session);
  await engine.process({ type: 'clock', at: session.open });
  await engine.process({ type: 'clock', at: session.close });
  expect((await repo.read()).sessions[0]?.status).toBe('no-trade');
  expect((await repo.read()).outbox.filter((x) => x.id === 'no-plan:2026-09-17')).toHaveLength(1);
});
it('new session reconciles an old position before accepting new entries', async () => {
  const repo = await repoWithPlan(),
    first = calendar.session('2026-09-17'),
    next = calendar.session('2026-09-18');
  if (!first || !next) throw new Error('No session');
  await repo.transact((s) => {
    s.session = first;
    s.cash = '4000';
    s.positions.DEMO = {
      symbol: 'DEMO',
      quantity: 10,
      entryPrice: '100',
      entryFee: '0',
      openedAt: first.open,
      stop: '99',
      initialRisk: '1',
      target: '102',
      highWaterPrice: '100',
      everHalfR: false,
      rank: 1,
      setupType: 'opening_range_breakout',
    };
  });
  const engine = new TradingEngine(repo, loadConfig({}));
  await engine.start(next);
  await engine.process({ type: 'quote', quote: quote(next.open) });
  expect((await repo.read()).orders.at(-1)?.reason).toBe('unresolved-reconciliation');
  expect((await repo.read()).positions.DEMO).toBeDefined();
  await engine.process({
    type: 'quote',
    quote: quote(new Date(Date.parse(next.open) + 5000).toISOString()),
  });
  expect((await repo.read()).positions.DEMO).toBeUndefined();
  expect((await repo.read()).executions).toHaveLength(1);
});

it('persists last-price-only observations without creating fills', async () => {
  const repo = await repoWithPlan();
  const last = { ...quote(at), bid: undefined, ask: undefined, source: 'finnhub:quote' };
  const worker: TradingWorker = new TradingWorker(
    loadConfig({}),
    repo,
    oneIterationClock(() => worker.shutdown()),
    calendar,
    new MockMarketDataProvider([last]),
    { publish: async () => undefined },
  );
  await worker.run();
  const state = await repo.read();
  expect(state.quotes[last.symbol]?.lastPrice).toBe(last.lastPrice);
  expect(state.quotes[last.symbol]?.bid).toBeUndefined();
  expect(state.executions).toHaveLength(0);
  expect(await repo.records('MarketDataSnapshot')).toHaveLength(0);
});

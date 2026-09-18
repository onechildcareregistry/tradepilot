import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initialState, type State, type Session, type Signal } from '../src/domain/models.js';
import { UsTradingCalendar, assertTimezoneData } from '../src/domain/TradingCalendar.js';
import { samplePlan, quote, bar, runDemo } from '../src/demo.js';
import { MemoryRepository } from '../src/persistence/Repository.js';
import { TradingEngine } from '../src/worker/TradingEngine.js';
import { MockBroker } from '../src/broker/MockBroker.js';
import { OpeningRangeBreakoutStrategy } from '../src/strategy/OpeningRangeBreakoutStrategy.js';
import { RiskEngine } from '../src/risk/RiskEngine.js';
import { validatePlan } from '../src/brain/validation.js';
import { publicReport, publicReportSchema } from '../src/reporting/PublicReport.js';
import { D } from '../src/domain/money.js';
const config = loadConfig({ TRADING_ENABLED: 'true', DATA_VERIFIED: 'true' });
const calendar = new UsTradingCalendar();
function session(): Session {
  const s = calendar.session('2026-09-17');
  if (!s) throw new Error('Missing fixture session');
  return s;
}
function setup(): State {
  const s = initialState();
  s.session = session();
  s.plans[s.session.date] = samplePlan(s.session);
  return s;
}
const at = '2026-09-17T13:37:00.000Z';
const signal: Signal = {
  id: 'entry',
  symbol: 'DEMO',
  side: 'buy',
  reason: 'test',
  at,
  trigger: '100',
  stop: '99',
};
function opened(): State {
  const s = setup(),
    broker = new MockBroker(config);
  broker.placeOrder(s, {
    id: 'entry',
    signalId: 'entry',
    symbol: 'DEMO',
    side: 'buy',
    quantity: 9,
    limit: '100.5',
    stop: '99',
    submittedAt: at,
    expiresAt: '2026-09-17T13:37:30.000Z',
    status: 'pending',
    reason: 'fixture',
    sessionDate: '2026-09-17',
    rank: 1,
    setupType: 'opening_range_breakout',
  });
  broker.processQuote(s, quote('2026-09-17T13:37:05.000Z'));
  return s;
}
describe('configuration and exchange calendar', () => {
  it('defaults to disabled Monopoly and rejects Real', () => {
    expect(loadConfig({}).TRADING_ENABLED).toBe(false);
    expect(() => loadConfig({ TRADEPILOT_MODE: 'Real' })).toThrow();
  });
  it('handles holidays and early closes, rejecting unreviewed years', () => {
    expect(calendar.session('2026-12-25')).toBeNull();
    expect(calendar.session('2026-11-27')?.close).toBe('2026-11-27T18:00:00.000Z');
    expect(() => calendar.session('2028-01-03')).toThrow();
  });
  it('keeps Vancouver cutoff fixed while New York changes DST', () => {
    assertTimezoneData();
    expect(calendar.cutoff('2026-12-01')).toBe('2026-12-01T13:15:00.000Z');
    expect(calendar.session('2026-12-01')?.open).toBe('2026-12-01T14:30:00.000Z');
  });
});
describe('deterministic risk decisions', () => {
  it('sizes whole shares against worst permissible fill', () => {
    const r = new RiskEngine(config).evaluate(setup(), signal, quote(at));
    expect(r.decision.approved).toBe(true);
    expect(r.quantity).toBe(9);
    expect(r.limit).toBe('100.50000000');
  });
  it.each([
    ['chase', quote(at, '101', '101.01')],
    ['data', quote('2026-09-17T13:36:00.000Z')],
  ])('rejects %s', (reason, q) => {
    expect(new RiskEngine(config).evaluate(setup(), signal, q).decision.reasons).toContain(reason);
  });
  it('accepts missing bid/ask but rejects future observations', () => {
    const q = quote(at);
    delete q.bid;
    delete q.ask;
    expect(new RiskEngine(config).evaluate(setup(), signal, q).decision.approved).toBe(true);
    expect(
      new RiskEngine(config).evaluate(setup(), signal, quote('2026-09-17T13:38:00.000Z')).decision
        .reasons,
    ).toContain('data');
  });
  it('rejects disabled, expired, outside market hours, and duplicate entries', () => {
    const s = setup();
    expect(
      new RiskEngine(loadConfig({})).evaluate(s, signal, quote(at)).decision.reasons,
    ).toContain('enabled');
    expect(
      new RiskEngine(config).evaluate(s, { ...signal, at: '2026-09-17T15:01:00.000Z' }, quote(at))
        .decision.reasons,
    ).toContain('plan');
    expect(
      new RiskEngine(config).evaluate(s, { ...signal, at: '2026-09-17T12:00:00.000Z' }, quote(at))
        .decision.reasons,
    ).toContain('marketHours');
    s.orders = opened().orders.map((o) => ({ ...o, status: 'pending' }));
    expect(new RiskEngine(config).evaluate(s, signal, quote(at)).decision.reasons).toContain(
      'duplicate',
    );
  });
  it('reserves cash and exposure for pending orders', () => {
    const s = setup();
    s.cash = '100';
    expect(new RiskEngine(config).evaluate(s, signal, quote(at)).quantity).toBe(0);
  });
  it('protective sells bypass disabled, expired plan, drawdown and missing quote checks', () => {
    const s = opened();
    s.drawdownHalt = true;
    s.plans = {};
    const r = new RiskEngine(loadConfig({})).evaluate(s, { ...signal, side: 'sell' }, undefined);
    expect(r.decision.approved).toBe(true);
    expect(r.quantity).toBe(9);
  });
});
describe('broker and strategy', () => {
  it('fills only a later observation and is idempotent', () => {
    const s = setup(),
      broker = new MockBroker(config);
    const order = opened().orders[0];
    if (!order) throw new Error('No fixture order');
    broker.placeOrder(s, { ...order, status: 'pending' });
    broker.processQuote(s, quote(at));
    expect(s.executions).toHaveLength(0);
    broker.processQuote(s, quote('2026-09-17T13:37:05.000Z'));
    broker.processQuote(s, quote('2026-09-17T13:37:05.000Z'));
    expect(s.executions).toHaveLength(1);
    expect(s.ledger).toHaveLength(2);
    expect(
      D(s.cash)
        .add(D(s.positions.DEMO?.entryPrice ?? '0').mul(9))
        .toString(),
    ).toBe('5000');
  });
  it('does not fill above the entry limit; cancels after TTL', () => {
    const s = setup(),
      broker = new MockBroker(config);
    const o = opened().orders[0];
    if (!o) throw new Error('No order');
    broker.placeOrder(s, { ...o, status: 'pending' });
    broker.processQuote(s, quote('2026-09-17T13:37:05.000Z', '102', '102.1'));
    expect(s.executions).toHaveLength(0);
    broker.processQuote(s, quote('2026-09-17T13:37:31.000Z'));
    expect(s.orders[0]?.status).toBe('canceled');
  });
  it('requires five contiguous opening bars and two consecutive closes', () => {
    const s = setup(),
      strategy = new OpeningRangeBreakoutStrategy(config),
      open = Date.parse(session().open);
    s.bars.DEMO = Array.from({ length: 7 }, (_, i) =>
      bar(new Date(open + i * 60000).toISOString(), i < 5 ? '99.8' : '100.10'),
    );
    const b = s.bars.DEMO.at(-1);
    if (!b) throw new Error('Missing bar');
    expect(strategy.onEvent(s, { type: 'bar', bar: b })[0]?.trigger).toBe('100.00000000');
    s.bars.DEMO.splice(2, 1);
    expect(strategy.onEvent(s, { type: 'bar', bar: b })).toHaveLength(0);
  });
  it('prioritizes stops and exits on clock events without inventing fills', () => {
    const s = opened(),
      strategy = new OpeningRangeBreakoutStrategy(config);
    expect(
      strategy.onEvent(s, {
        type: 'quote',
        quote: quote('2026-09-17T13:38:00.000Z', '98', '98.1'),
      })[0]?.reason,
    ).toBe('stop');
    expect(strategy.onEvent(s, { type: 'clock', at: '2026-09-17T14:08:00.000Z' })[0]?.reason).toBe(
      'time-invalidation',
    );
    expect(strategy.onEvent(s, { type: 'clock', at: session().exitAt })[0]?.reason).toBe(
      'session-exit',
    );
    expect(s.positions.DEMO).toBeDefined();
  });
  it('trails only after +1R and never loosens a stop', () => {
    const s = opened(),
      p = s.positions.DEMO;
    if (!p) throw new Error('No position');
    const strategy = new OpeningRangeBreakoutStrategy(config);
    p.highWaterPrice = '101.5';
    s.bars.DEMO = [
      { ...bar('2026-09-17T13:38:00.000Z', '100.1'), low: '100.2' },
      { ...bar('2026-09-17T13:39:00.000Z', '100.1'), low: '100.3' },
    ];
    const b = s.bars.DEMO[1];
    if (!b) throw new Error('Missing bar');
    strategy.onEvent(s, { type: 'bar', bar: b });
    expect(p.stop).toBe('100.20000000');
    b.low = '99';
    strategy.onEvent(s, { type: 'bar', bar: b });
    expect(p.stop).toBe('100.20000000');
  });
  it('gap stop fills at subsequent observed last price, not stop price', async () => {
    const repo = new MemoryRepository(opened()),
      engine = new TradingEngine(repo, config);
    await engine.process({ type: 'quote', quote: quote('2026-09-17T13:38:00.000Z', '98', '98.1') });
    expect((await repo.read()).executions).toHaveLength(1);
    await engine.process({ type: 'quote', quote: quote('2026-09-17T13:38:05.000Z', '97', '97.1') });
    const s = await repo.read();
    expect(s.executions.at(-1)?.price).toBe('96.95150000');
    expect(s.positions).toEqual({});
  });
  it('latches drawdown and cancels pending entries', async () => {
    const s = opened();
    s.equityHigh = '6000';
    const repo = new MemoryRepository(s);
    await new TradingEngine(repo, config).process({
      type: 'quote',
      quote: quote('2026-09-17T13:38:00.000Z'),
    });
    expect((await repo.read()).drawdownHalt).toBe(true);
    expect((await repo.read()).orders.at(-1)?.reason).toBe('risk-liquidation');
  });
});
describe('plans and end-to-end reports', () => {
  it('validates a plan and rejects duplicate, malformed, late or post-cutoff evidence', () => {
    const s = session(),
      p = samplePlan(s);
    expect(validatePlan(p, s, p.generatedAt).candidates).toHaveLength(1);
    expect(() => validatePlan({}, s, p.generatedAt)).toThrow();
    expect(() =>
      validatePlan({ ...p, candidates: [...p.candidates, ...p.candidates] }, s, p.generatedAt),
    ).toThrow();
    expect(() => validatePlan(p, s, s.close)).toThrow();
    const bad = structuredClone(p),
      source = bad.candidates[0]?.sources[0];
    if (source) source.publishedAt = s.open;
    expect(() => validatePlan(bad, s, p.generatedAt)).toThrow();
  });
  it('produces identical complete-day results and an allowlisted report', async () => {
    const a = new MemoryRepository(),
      b = new MemoryRepository();
    const first = await runDemo(a),
      second = await runDemo(b);
    expect(first).toEqual(second);
    expect(first.metrics.tradeCount).toBe(1);
    expect(first.metrics.equity).toBe(5021.5883);
    expect(first.status).toBe('closed');
    expect(JSON.stringify(first)).not.toMatch(/entryPrice|sources|apiKey/);
    expect(first.reportHistory[0]?.candidates[0]?.symbol).toBe('DEMO');
    expect(() => publicReportSchema.parse({ ...first, quotes: [] })).toThrow();
    const state = await a.read();
    expect(D(state.cash).eq(state.ledger.reduce((sum, x) => sum.add(x.amount), D(0)))).toBe(true);
  });
  it('retains missing-data positions at close for reconciliation', async () => {
    const repo = new MemoryRepository(opened());
    await new TradingEngine(repo, config).process({ type: 'clock', at: session().close });
    expect(Object.keys((await repo.read()).positions)).toEqual(['DEMO']);
  });
  it('exposes approved report summaries without evidence or execution prices', () => {
    const s = opened();
    const r = publicReport(s, at);
    expect(Object.keys(r)).not.toContain('plans');
    expect(JSON.stringify(r)).not.toContain('triggerPrice');
    expect(JSON.stringify(r)).not.toContain('sources');
    expect(r.reportHistory).toHaveLength(1);
  });
  it('tracks watchlist candidates without allowing them to create entry signals', async () => {
    const s = opened();
    const plan = s.plans[session().date];
    if (!plan) throw new Error('Missing plan');
    const recommended = plan.candidates[0];
    if (!recommended) throw new Error('Missing recommended candidate');
    plan.watchlist = [
      {
        ...recommended,
        rank: 4,
        symbol: 'WATCH',
        watchReason: 'Runner-up for evaluation only',
      },
    ];
    const repo = new MemoryRepository(s);
    const engine = new TradingEngine(repo, config);
    await engine.process({ type: 'bar', bar: bar(session().open, '101', 'WATCH') });
    expect((await repo.read()).signals.some((signal) => signal.symbol === 'WATCH')).toBe(false);
  });
});

it('normalizes offset timestamps before enforcing the research cutoff', () => {
  const ses = session(),
    plan = samplePlan(ses),
    source = plan.candidates[0]?.sources[0];
  if (!source) throw new Error('Missing source');
  source.publishedAt = '2026-09-17T09:16:00-04:00';
  expect(() => validatePlan(plan, ses, plan.generatedAt)).toThrow('Post-cutoff');
  source.publishedAt = '2026-09-17T06:14:00-07:00';
  expect(validatePlan(plan, ses, plan.generatedAt).candidates[0]?.sources[0]?.publishedAt).toBe(
    '2026-09-17T13:14:00.000Z',
  );
});
it('keeps the worst observed drawdown even when it recovers before the next minute snapshot', async () => {
  const s = opened(),
    repo = new MemoryRepository(s),
    engine = new TradingEngine(repo, config);
  await engine.process({
    type: 'quote',
    quote: quote('2026-09-17T13:37:10.000Z', '100', '100.05'),
  });
  await engine.process({
    type: 'quote',
    quote: quote('2026-09-17T13:37:15.000Z', '99.2', '99.25'),
  });
  const worst = (await repo.read()).maximumDrawdown;
  await engine.process({
    type: 'quote',
    quote: quote('2026-09-17T13:37:20.000Z', '100.1', '100.15'),
  });
  expect((await repo.read()).maximumDrawdown).toBe(worst);
  expect(Number(worst)).toBeGreaterThan(0);
});

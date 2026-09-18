import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { D, amount } from '../domain/money.js';
import type { Config } from '../config.js';
import { publicConfig } from '../config.js';
import type { MarketEvent, Session, State } from '../domain/models.js';
import type { Repository } from '../persistence/Repository.js';
import { portfolio } from '../portfolio/PortfolioService.js';
import { MockBroker } from '../broker/MockBroker.js';
import { OrderManager } from '../broker/OrderManager.js';
import { RiskEngine } from '../risk/RiskEngine.js';
import { OpeningRangeBreakoutStrategy } from '../strategy/OpeningRangeBreakoutStrategy.js';
export class TradingEngine {
  private broker: MockBroker;
  private risk: RiskEngine;
  private manager: OrderManager;
  private strategy: OpeningRangeBreakoutStrategy;
  constructor(
    private repository: Repository,
    private c: Config,
    private owner?: string,
  ) {
    this.broker = new MockBroker(c);
    this.risk = new RiskEngine(c);
    this.manager = new OrderManager(this.broker, this.risk, c);
    this.strategy = new OpeningRangeBreakoutStrategy(c);
  }
  async start(session: Session): Promise<void> {
    await this.repository.transact((s, audit) => {
      const config = publicConfig(this.c);
      const configId = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      audit.push({
        entity: 'ConfigurationSnapshot',
        id: `${session.date}:${configId}`,
        at: new Date().toISOString(),
        payload: config,
      });
      if (s.session?.date === session.date) return;
      for (const o of s.orders) if (o.status === 'pending') o.status = 'canceled';
      s.session = session;
      s.bars = {};
      s.processedBars = {};
      s.dailyHalt = false;
      s.sessionStartEquity = portfolio(s, session.open).equity;
      const status = Object.keys(s.positions).length
        ? 'unresolved'
        : this.c.TRADING_ENABLED
          ? 'waiting'
          : 'observing';
      s.sessions.push({
        date: session.date,
        status,
        startingEquity: s.sessionStartEquity,
        endingEquity: null,
        reason: null,
        config: publicConfig(this.c),
      });
      audit.push({
        entity: 'ConfigurationSnapshot',
        id: session.date,
        at: session.open,
        payload: publicConfig(this.c),
      });
    }, this.owner);
  }
  async process(event: MarketEvent): Promise<void> {
    await this.repository.transact((s, audit) => {
      const at =
          event.type === 'quote'
            ? event.quote.receivedAt
            : event.type === 'bar'
              ? event.bar.receivedAt
              : event.at,
        session = s.session;
      if (!session) return;
      const decisionsBefore = s.decisions.length,
        executionsBefore = s.executions.length,
        positionsBefore = JSON.stringify(s.positions);
      if (event.type === 'quote') {
        const q = event.quote;
        if (
          !Number.isFinite(Date.parse(q.timestamp)) ||
          Date.parse(q.timestamp) > Date.parse(at) ||
          Date.parse(at) - Date.parse(q.timestamp) > this.c.STALE_SECONDS * 1000 ||
          !D(q.lastPrice).gt(0)
        )
          return;
        const previous = s.quotes[q.symbol];
        if (previous && q.timestamp <= previous.timestamp) return;
        s.quotes[q.symbol] = q;
      } else if (event.type === 'bar') {
        const b = event.bar;
        if (
          b.end > at ||
          Date.parse(b.end) - Date.parse(b.start) !== 60000 ||
          b.start < session.open ||
          b.end > session.close ||
          D(b.high).lt(Decimal.max(b.open, b.close, b.low)) ||
          D(b.low).gt(Decimal.min(b.open, b.close, b.high))
        )
          return;
        const last = s.processedBars[b.symbol];
        if (last && b.start <= last) return;
        const bars = s.bars[b.symbol] ?? [];
        bars.push(b);
        s.bars[b.symbol] = bars;
        s.processedBars[b.symbol] = b.start;
        audit.push({
          entity: 'MarketDataSnapshot',
          id: `bar:${b.symbol}:${b.start}`,
          at,
          payload: event,
        });
      }
      const snap = portfolio(s, at);
      s.equityHigh = amount(Decimal.max(s.equityHigh, snap.equity));
      if (D(snap.drawdown).gte(this.c.MAX_DRAWDOWN)) s.drawdownHalt = true;
      if (
        D(s.sessionStartEquity)
          .sub(snap.equity)
          .div(s.sessionStartEquity)
          .gte(this.c.MAX_DAILY_LOSS)
      )
        s.dailyHalt = true;
      for (const o of s.orders)
        if (
          o.status === 'pending' &&
          o.side === 'buy' &&
          (at >= o.expiresAt ||
            at >= session.entryDeadline ||
            s.dailyHalt ||
            s.drawdownHalt ||
            !this.c.TRADING_ENABLED)
        )
          o.status = 'canceled';
      if (
        event.type === 'quote' &&
        event.quote.timestamp >= session.open &&
        at >= session.open &&
        at < session.close
      ) {
        for (const o of s.orders.filter(
          (o) => o.status === 'pending' && o.symbol === event.quote.symbol && o.side === 'buy',
        )) {
          const original = s.signals.find((x) => x.id === o.signalId);
          if (!original) {
            o.status = 'canceled';
            continue;
          }
          const result = this.risk.evaluate(s, { ...original, at }, event.quote, o.id);
          s.decisions.push(result.decision);
          if (!result.decision.approved || result.quantity < o.quantity) o.status = 'canceled';
        }
        this.broker.processQuote(s, event.quote);
      }
      const signals = this.strategy.onEvent(s, event);
      for (const signal of signals) this.manager.submit(s, signal);
      this.outcomes(
        s,
        event,
        signals.some((x) => x.side === 'buy'),
      );
      if (event.type === 'quote') {
        const quoteChangedDecision = s.decisions.length > decisionsBefore;
        const quoteChangedExecution = s.executions.length > executionsBefore;
        const quoteChangedPosition = JSON.stringify(s.positions) !== positionsBefore;
        if (quoteChangedDecision || quoteChangedExecution || quoteChangedPosition)
          audit.push({
            entity: 'MarketDataSnapshot',
            id: `decision-price:${event.quote.symbol}:${event.quote.timestamp}`,
            at,
            payload: event,
          });
      }
      if (event.type === 'bar') {
        const outcome = s.outcomes[`${session.date}:${event.bar.symbol}`];
        if (outcome)
          audit.push({
            entity: 'CandidateOutcome',
            id: `${session.date}:${event.bar.symbol}:${event.bar.start}`,
            at,
            payload: outcome,
          });
      }
      const updated = portfolio(s, at),
        last = s.snapshots.at(-1);
      s.maximumDrawdown = amount(
        Decimal.max(s.maximumDrawdown ?? 0, snap.drawdown, updated.drawdown),
      );
      if (!last || Date.parse(at) - Date.parse(last.at) >= 60000 || at >= session.close)
        s.snapshots.push(updated);
      const record = s.sessions.find((x) => x.date === session.date);
      if (record) {
        if (at >= session.close) {
          for (const o of s.orders) if (o.status === 'pending') o.status = 'canceled';
          record.status = Object.keys(s.positions).length
            ? 'unresolved'
            : s.plans[session.date]
              ? 'closed'
              : 'no-trade';
          record.endingEquity = updated.equity;
          if (
            record.status === 'unresolved' &&
            !s.outbox.some((x) => x.id === `unresolved:${session.date}`)
          )
            s.outbox.push({
              id: `unresolved:${session.date}`,
              subject: 'TradePilot: unresolved simulated position',
              text: 'No eligible closing observation was available. Position retained for next-session reconciliation; no fabricated fill.',
              sentAt: null,
              attempts: 0,
            });
        } else if (at >= session.open) {
          const plan = s.plans[session.date];
          record.status = Object.keys(s.positions).some(
            (k) => (s.positions[k]?.openedAt ?? at) < session.open,
          )
            ? 'unresolved'
            : !plan
              ? 'no-trade'
              : this.c.TRADING_ENABLED
                ? 'trading'
                : 'observing';
          if (!plan) {
            record.reason = 'No approved plan before market open';
            if (!s.outbox.some((x) => x.id === `no-plan:${session.date}`))
              s.outbox.push({
                id: `no-plan:${session.date}`,
                subject: 'TradePilot: no-trade session',
                text: 'No approved plan was available before the market opened. New entries are disabled for this session.',
                sentAt: null,
                attempts: 0,
              });
          }
        }
      }
      const checkpointNeeded =
        event.type !== 'quote' ||
        s.decisions.length > decisionsBefore ||
        s.executions.length > executionsBefore ||
        JSON.stringify(s.positions) !== positionsBefore;
      if (checkpointNeeded)
        audit.push({
          entity: 'SessionCheckpoint',
          id: `${session.date}:${at}:${event.type}:${event.type === 'quote' ? event.quote.symbol : event.type === 'bar' ? event.bar.symbol : ''}`,
          at,
          payload: { status: record?.status, openPositions: Object.keys(s.positions).length },
        });
    }, this.owner);
  }
  private outcomes(s: State, event: MarketEvent, triggered: boolean): void {
    const session = s.session;
    if (!session) return;
    const symbol =
      event.type === 'quote'
        ? event.quote.symbol
        : event.type === 'bar'
          ? event.bar.symbol
          : undefined;
    if (!symbol) return;
    const plan = s.plans[session.date];
    const c = [...(plan?.candidates ?? []), ...(plan?.watchlist ?? [])].find(
      (candidate) => candidate.symbol === symbol,
    );
    if (!c) return;
    const key = `${session.date}:${symbol}`,
      at =
        event.type === 'quote' ? event.quote.timestamp : event.type === 'bar' ? event.bar.end : '';
    const o = s.outcomes[key] ?? {
      date: session.date,
      symbol,
      rank: c.rank,
      setupType: c.setupType,
      explosionScore: c.explosionScore,
      entryQuality: c.entryQuality,
      exhaustionScore: c.premarket.exhaustionScore,
      triggered: false,
      stopAt: null,
      moveAt: null,
      trigger: null,
      observedHigh: null,
      observedLow: null,
      observations: 0,
      feed:
        event.type === 'quote'
          ? event.quote.source
          : event.type === 'bar'
            ? event.bar.source
            : 'unknown',
      actualMovePercent: null,
      stopBeforeMove: null,
    };
    o.triggered ||= triggered;
    const signal = s.signals.find(
      (x) => x.symbol === symbol && x.side === 'buy' && x.at >= session.open,
    );
    if (signal?.trigger) o.trigger = signal.trigger;
    if (
      event.type === 'quote' &&
      event.quote.timestamp >= session.open &&
      at >= session.open &&
      at < session.close
    ) {
      const price = event.quote.lastPrice;
      o.observations++;
      o.observedHigh = amount(Decimal.max(o.observedHigh ?? price, price));
      o.observedLow = amount(Decimal.min(o.observedLow ?? price, price));
      if (signal?.stop && o.trigger) {
        if (!o.stopAt && D(price).lte(signal.stop)) o.stopAt = at;
        const risk = D(o.trigger).sub(signal.stop);
        if (!o.moveAt && D(price).gte(D(o.trigger).add(risk.mul(this.c.TARGET_R)))) o.moveAt = at;
        o.actualMovePercent = D(o.observedHigh).sub(o.trigger).div(o.trigger).mul(100).toNumber();
        o.stopBeforeMove = o.stopAt && o.moveAt ? o.stopAt < o.moveAt : null;
      }
    }
    s.outcomes[key] = o;
  }
}

import { Decimal } from 'decimal.js';
import { D, amount } from '../domain/money.js';
import type { Config } from '../config.js';
import type { MarketEvent, Signal, State } from '../domain/models.js';
import type { StrategyEngine } from './StrategyEngine.js';
export class OpeningRangeBreakoutStrategy implements StrategyEngine {
  constructor(private c: Config) {}
  onEvent(s: State, event: MarketEvent): Signal[] {
    const at =
        event.type === 'quote'
          ? event.quote.receivedAt
          : event.type === 'bar'
            ? event.bar.receivedAt
            : event.at,
      session = s.session;
    if (!session || at < session.open || at >= session.close) return [];
    const signals: Signal[] = [];
    for (const p of Object.values(s.positions)) {
      let reason: string | undefined;
      const q = event.type === 'quote' && event.quote.symbol === p.symbol ? event.quote : undefined;
      if (q?.lastPrice) {
        p.highWaterPrice = amount(Decimal.max(p.highWaterPrice, q.lastPrice));
        if (D(q.lastPrice).gte(D(p.entryPrice).add(D(p.initialRisk).mul(0.5)))) p.everHalfR = true;
      }
      if (s.dailyHalt || s.drawdownHalt) reason = 'risk-liquidation';
      else if (p.openedAt < session.open) reason = 'unresolved-reconciliation';
      else if (at >= session.exitAt) reason = 'session-exit';
      else if (q?.lastPrice && D(q.lastPrice).lte(p.stop)) reason = 'stop';
      else if (q?.lastPrice && D(q.lastPrice).gte(p.target)) reason = 'target';
      else if (
        !p.everHalfR &&
        Date.parse(at) - Date.parse(p.openedAt) >= this.c.TIME_EXIT_MINUTES * 60000
      )
        reason = 'time-invalidation';
      if (reason) {
        signals.push({
          id: `${session.date}:${p.symbol}:exit:${reason}`,
          symbol: p.symbol,
          side: 'sell',
          reason,
          at,
        });
        continue;
      }
      if (
        event.type === 'bar' &&
        event.bar.symbol === p.symbol &&
        D(p.highWaterPrice).gte(D(p.entryPrice).add(p.initialRisk))
      ) {
        const bars = (s.bars[p.symbol] ?? [])
          .filter((b) => b.end <= at && b.start >= p.openedAt)
          .slice(-2);
        if (bars.length === 2)
          p.stop = amount(Decimal.max(p.stop, Decimal.min(...bars.map((b) => D(b.low)))));
      }
    }
    if (event.type !== 'bar' || at >= session.entryDeadline) return signals;
    const plan = s.plans[session.date],
      candidate = plan?.candidates.find((c) => c.symbol === event.bar.symbol);
    if (!candidate || s.positions[candidate.symbol]) return signals;
    const bars = s.bars[candidate.symbol] ?? [],
      rangeEnd = Date.parse(session.open) + 300000;
    const range = bars.filter(
      (b) => Date.parse(b.start) >= Date.parse(session.open) && Date.parse(b.start) < rangeEnd,
    );
    if (
      range.length !== 5 ||
      range.some((b, i) => Date.parse(b.start) !== Date.parse(session.open) + i * 60000)
    )
      return signals;
    const trigger = Decimal.max(candidate.triggerPrice, ...range.map((b) => D(b.high))),
      stop = Decimal.min(...range.map((b) => D(b.low)));
    const confirmation = bars
      .filter((b) => Date.parse(b.start) >= rangeEnd && b.end <= at)
      .slice(-2);
    if (confirmation.length !== 2) return signals;
    const [first, second] = confirmation;
    if (
      !first ||
      !second ||
      first.end !== second.start ||
      second.end !== event.bar.end ||
      Date.parse(at) - Date.parse(second.end) > this.c.STALE_SECONDS * 1000
    )
      return signals;
    if (confirmation.every((b) => D(b.close).gt(trigger)))
      signals.push({
        id: `${session.date}:${candidate.symbol}:entry:${second.end}`,
        symbol: candidate.symbol,
        side: 'buy',
        reason: 'confirmed-opening-range-breakout',
        at,
        trigger: amount(trigger),
        stop: amount(stop),
      });
    return signals;
  }
}

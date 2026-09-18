import { Decimal } from 'decimal.js';
import type { Config } from '../config.js';
import { D, amount } from '../domain/money.js';
import type { Quote, RiskDecision, Signal, State } from '../domain/models.js';
import { portfolio } from '../portfolio/PortfolioService.js';
import { fillPrice } from '../broker/MockBroker.js';
export interface RiskResult {
  decision: RiskDecision;
  quantity: number;
  limit?: string;
}
export class RiskEngine {
  constructor(private c: Config) {}
  evaluate(s: State, signal: Signal, q: Quote | undefined, ignoreOrderId?: string): RiskResult {
    const at = signal.at,
      session = s.session,
      p = s.positions[signal.symbol];
    const checks: Record<string, boolean> = {
      marketHours: !!session && at >= session.open && at < session.close,
      duplicate: !s.orders.some(
        (o) => o.status === 'pending' && o.symbol === signal.symbol && o.id !== ignoreOrderId,
      ),
    };
    let quantity = 0,
      limit: string | undefined;
    if (signal.side === 'sell') {
      checks.position = !!p;
      quantity = p?.quantity ?? 0;
    } else {
      const plan = session ? s.plans[session.date] : undefined,
        candidate = plan?.candidates.find((x) => x.symbol === signal.symbol),
        snap = portfolio(s, at),
        equity = D(snap.equity);
      const pending = s.orders.filter(
        (o) => o.side === 'buy' && o.status === 'pending' && o.id !== ignoreOrderId,
      );
      const reserved = pending.reduce(
        (sum, o) => sum.add(D(o.limit ?? '0').mul(o.quantity)).add(this.c.FEE_PER_ORDER),
        D(0),
      );
      const held = Object.values(s.positions).reduce(
        (sum, x) => sum.add(D(s.quotes[x.symbol]?.lastPrice ?? x.entryPrice).mul(x.quantity)),
        D(0),
      );
      const price = q ? fillPrice(q, 'buy', this.c) : null,
        stop = signal.stop,
        trigger = signal.trigger;
      checks.enabled = this.c.TRADING_ENABLED;
      checks.verified = this.c.DATA_VERIFIED;
      checks.noHalt = !s.dailyHalt && !s.drawdownHalt;
      checks.plan =
        !!plan && !!candidate && plan.generatedAt <= (session?.open ?? '') && at < plan.expiresAt;
      checks.entryWindow = !!session && at < session.entryDeadline && at < session.exitAt;
      checks.quality = !!candidate && candidate.entryQuality >= this.c.MIN_ENTRY_QUALITY;
      checks.data =
        !!q &&
        D(q.lastPrice).gt(0) &&
        Date.parse(at) - Date.parse(q.timestamp) >= 0 &&
        Date.parse(at) - Date.parse(q.timestamp) <= this.c.STALE_SECONDS * 1000;
      checks.noPosition = !p;
      checks.unresolved = Object.keys(s.positions).every(
        (symbol) => s.positions[symbol]?.openedAt.slice(0, 10) === session?.date,
      );
      checks.maxPositions = Object.keys(s.positions).length + pending.length < this.c.MAX_POSITIONS;
      checks.entryCount =
        s.executions.filter(
          (e) => e.side === 'buy' && e.symbol === signal.symbol && e.sessionDate === session?.date,
        ).length < this.c.MAX_ENTRIES_PER_SYMBOL;
      checks.loss =
        D(s.sessionStartEquity).sub(equity).div(s.sessionStartEquity).lt(this.c.MAX_DAILY_LOSS) &&
        D(snap.drawdown).lt(this.c.MAX_DRAWDOWN);
      checks.structure =
        !!price &&
        !!stop &&
        !!trigger &&
        D(price).gt(stop) &&
        D(price).sub(stop).div(price).lte(this.c.MAX_STOP_DISTANCE) &&
        D(price).gte(trigger);
      checks.chase =
        !!price && !!trigger && D(price).lte(D(trigger).mul(D(1).add(this.c.MAX_CHASE)));
      if (price && stop && trigger && candidate && D(price).gt(stop)) {
        limit = amount(D(trigger).mul(D(1).add(this.c.MAX_CHASE)));
        // Size at the worst permitted fill, not the current last price.
        const worst = D(limit),
          risk = worst.sub(stop),
          fee = D(this.c.FEE_PER_ORDER);
        const maxAllocation = Decimal.min(this.c.MAX_ALLOCATION, candidate.maximumAllocation);
        quantity = Math.max(
          0,
          Decimal.min(
            D(s.sessionStartEquity).mul(this.c.RISK_PER_TRADE).sub(fee.mul(2)).div(risk),
            equity.mul(maxAllocation).sub(fee).div(worst),
            equity.mul(this.c.MAX_EXPOSURE).sub(held).sub(reserved).sub(fee).div(worst),
            D(s.cash).sub(reserved).sub(fee).div(worst),
          )
            .floor()
            .toNumber(),
        );
      }
      checks.sizing = quantity > 0;
    }
    const reasons = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    return {
      decision: {
        id: `risk:${signal.id}:${ignoreOrderId ? 'fill' : 'submit'}:${at}`,
        signalId: signal.id,
        at,
        approved: reasons.length === 0,
        reasons,
        checks,
      },
      quantity,
      limit,
    };
  }
}

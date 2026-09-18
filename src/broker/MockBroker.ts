import type { Broker } from './Broker.js';
import type { Config } from '../config.js';
import { D, amount } from '../domain/money.js';
import type { Order, Position, Quote, State, Execution } from '../domain/models.js';
export function fillPrice(q: Quote, side: 'buy' | 'sell', c: Config): string | null {
  const base = q.lastPrice;
  if (!base) return null;
  return amount(
    D(base).mul(
      D(1).add(
        D(c.SLIPPAGE_BPS)
          .div(10000)
          .mul(side === 'buy' ? 1 : -1),
      ),
    ),
  );
}
export class MockBroker implements Broker {
  readonly mode = 'Monopoly' as const;
  constructor(private config: Config) {}
  getAccount(s: State): { cash: string; currency: 'USD' } {
    return { cash: s.cash, currency: 'USD' };
  }
  getPositions(s: State): Position[] {
    return Object.values(s.positions);
  }
  placeOrder(s: State, o: Order): Order {
    const existing = s.orders.find((x) => x.signalId === o.signalId);
    if (existing) return existing;
    if (!Number.isInteger(o.quantity) || o.quantity <= 0)
      throw new Error('Whole positive shares required');
    s.orders.push(o);
    return o;
  }
  cancelOrder(s: State, id: string): void {
    const o = s.orders.find((x) => x.id === id);
    if (o?.status === 'pending') o.status = 'canceled';
  }
  processQuote(s: State, q: Quote): void {
    for (const o of s.orders.filter((x) => x.status === 'pending' && x.symbol === q.symbol)) {
      if (q.timestamp <= o.submittedAt) continue;
      if (o.side === 'buy' && q.receivedAt >= o.expiresAt) {
        o.status = 'canceled';
        continue;
      }
      const price = fillPrice(q, o.side, this.config);
      if (!price || !D(price).gt(0)) continue;
      if (o.limit && D(price).gt(o.limit)) continue;
      const fee = D(this.config.FEE_PER_ORDER),
        notional = D(price).mul(o.quantity),
        id = `fill:${o.id}`;
      if (s.executions.some((x) => x.id === id)) continue;
      let realized: string | null = null,
        holding: number | null = null;
      if (o.side === 'buy') {
        if (
          s.positions[o.symbol] ||
          !o.stop ||
          D(o.stop).gte(price) ||
          D(s.cash).lt(notional.add(fee))
        ) {
          o.status = 'canceled';
          continue;
        }
        const risk = D(price).sub(o.stop);
        s.positions[o.symbol] = {
          symbol: o.symbol,
          quantity: o.quantity,
          entryPrice: price,
          entryFee: amount(fee),
          openedAt: q.timestamp,
          stop: o.stop,
          initialRisk: amount(risk),
          target: amount(D(price).add(risk.mul(this.config.TARGET_R))),
          highWaterPrice: price,
          everHalfR: false,
          rank: o.rank,
          setupType: o.setupType,
        };
      } else {
        const p = s.positions[o.symbol];
        if (!p || p.quantity !== o.quantity) {
          o.status = 'canceled';
          continue;
        }
        realized = amount(D(price).sub(p.entryPrice).mul(o.quantity).sub(fee).sub(p.entryFee));
        holding = (Date.parse(q.timestamp) - Date.parse(p.openedAt)) / 1000;
        s.realizedPnl = amount(D(s.realizedPnl).add(realized));
        delete s.positions[o.symbol];
      }
      const cashChange = o.side === 'buy' ? notional.add(fee).neg() : notional.sub(fee);
      s.cash = amount(D(s.cash).add(cashChange));
      const reference = q.lastPrice;
      if (!reference) throw new Error('Missing validated last price');
      const execution: Execution = {
        id,
        orderId: o.id,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        price,
        referencePrice: reference,
        fee: amount(fee),
        slippage: amount(D(price).sub(reference).abs().mul(o.quantity)),
        at: q.timestamp,
        source: q.source,
        coverage: q.coverage,
        sessionDate: o.sessionDate,
        rank: o.rank,
        setupType: o.setupType,
        realizedPnl: realized,
        holdingSeconds: holding,
      };
      s.executions.push(execution);
      s.ledger.push({
        id: `cash:${id}`,
        at: q.timestamp,
        amount: amount(cashChange),
        reason: o.side,
        executionId: id,
      });
      o.status = 'filled';
    }
  }
}

import { Decimal } from 'decimal.js';
import { D, amount } from '../domain/money.js';
import type { State, Snapshot } from '../domain/models.js';
export function portfolio(s: State, at: string): Snapshot {
  let value = D(0),
    unrealized = D(0);
  for (const p of Object.values(s.positions)) {
    const mark = D(s.quotes[p.symbol]?.lastPrice ?? p.entryPrice);
    value = value.add(mark.mul(p.quantity));
    unrealized = unrealized.add(mark.sub(p.entryPrice).mul(p.quantity).sub(p.entryFee));
  }
  const equity = D(s.cash).add(value),
    high = D(s.equityHigh);
  return {
    at,
    equity: amount(equity),
    cash: s.cash,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: amount(unrealized),
    drawdown: amount(high.gt(0) ? Decimal.max(0, high.sub(equity).div(high)) : 0),
  };
}

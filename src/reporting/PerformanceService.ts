import { D } from '../domain/money.js';
import type { State, Execution } from '../domain/models.js';
import { portfolio } from '../portfolio/PortfolioService.js';
function statistics(trades: Execution[]) {
  const pnl = trades.map((t) => Number(t.realizedPnl)),
    wins = pnl.filter((x) => x > 0),
    losses = pnl.filter((x) => x < 0);
  const avg = (a: number[]) =>
    a.length
      ? a
          .reduce((sum, value) => sum.add(value), D(0))
          .div(a.length)
          .toNumber()
      : null;
  return {
    tradeCount: pnl.length,
    winRate: pnl.length ? wins.length / pnl.length : null,
    averageWinner: avg(wins),
    averageLoser: avg(losses),
    maximumWinner: wins.length ? Math.max(...wins) : null,
    maximumLoser: losses.length ? Math.min(...losses) : null,
    averageHoldingSeconds: avg(
      trades.flatMap((x) => (x.holdingSeconds === null ? [] : [x.holdingSeconds])),
    ),
    pnl: pnl.reduce((sum, value) => sum.add(value), D(0)).toNumber(),
  };
}
function group(trades: Execution[], key: (e: Execution) => string) {
  const groups = new Map<string, Execution[]>();
  for (const t of trades) {
    const k = key(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups].map(([label, items]) => ({ label, ...statistics(items) }));
}
export function performance(s: State, at: string) {
  const snap = portfolio(s, at),
    closed = s.executions.filter((x) => x.side === 'sell' && x.realizedPnl !== null),
    outcomes = Object.values(s.outcomes);
  return {
    startingEquity: 5000,
    endingEquity: Number(snap.equity),
    dailyPnl: D(snap.equity).sub(s.sessionStartEquity).toNumber(),
    cumulativePnl: D(snap.equity).sub(5000).toNumber(),
    dailyReturn: D(snap.equity).div(s.sessionStartEquity).sub(1).toNumber(),
    cumulativeReturn: D(snap.equity).div(5000).sub(1).toNumber(),
    realizedPnl: Number(s.realizedPnl),
    unrealizedPnl: Number(snap.unrealizedPnl),
    maximumDrawdown: Math.max(
      Number(s.maximumDrawdown ?? 0),
      ...s.snapshots.map((x) => Number(x.drawdown)),
      Number(snap.drawdown),
    ),
    ...statistics(closed),
    byTicker: group(closed, (x) => x.symbol),
    bySetup: group(closed, (x) => x.setupType),
    byRank: group(closed, (x) => String(x.rank)),
    slippageImpact: s.executions.reduce((sum, x) => sum.add(x.slippage), D(0)).toNumber(),
    triggerRate: outcomes.length
      ? outcomes.filter((x) => x.triggered).length / outcomes.length
      : null,
    noTriggerRate: outcomes.length
      ? outcomes.filter((x) => !x.triggered).length / outcomes.length
      : null,
    stopHitBeforeMoveRate: outcomes.some((x) => x.stopBeforeMove !== null)
      ? outcomes.filter((x) => x.stopBeforeMove === true).length /
        outcomes.filter((x) => x.stopBeforeMove !== null).length
      : null,
    candidateOutcomes: outcomes,
    measurement: 'Observed provider price paths; missing evidence is unavailable, not zero',
  };
}

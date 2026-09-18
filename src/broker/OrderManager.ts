import type { Broker } from './Broker.js';
import type { Config } from '../config.js';
import type { Signal, State } from '../domain/models.js';
import { RiskEngine } from '../risk/RiskEngine.js';
export class OrderManager {
  constructor(
    private broker: Broker,
    private risk: RiskEngine,
    private c: Config,
  ) {
    if (broker.mode !== 'Monopoly') throw new Error('Only MockBroker supported');
  }
  submit(s: State, signal: Signal): void {
    if (s.signals.some((x) => x.id === signal.id)) return;
    s.signals.push(signal);
    const result = this.risk.evaluate(s, signal, s.quotes[signal.symbol]);
    s.decisions.push(result.decision);
    if (!result.decision.approved) return;
    const candidate = s.session
        ? s.plans[s.session.date]?.candidates.find((x) => x.symbol === signal.symbol)
        : undefined,
      p = s.positions[signal.symbol];
    this.broker.placeOrder(s, {
      id: `order:${signal.id}`,
      signalId: signal.id,
      symbol: signal.symbol,
      side: signal.side,
      quantity: result.quantity,
      limit: signal.side === 'buy' ? result.limit : undefined,
      stop: signal.stop,
      submittedAt: signal.at,
      expiresAt: new Date(
        Date.parse(signal.at) +
          (signal.side === 'buy' ? this.c.ENTRY_TTL_SECONDS * 1000 : 86400000),
      ).toISOString(),
      status: 'pending',
      reason: signal.reason,
      sessionDate: s.session?.date ?? signal.at.slice(0, 10),
      rank: candidate?.rank ?? p?.rank ?? 0,
      setupType: candidate?.setupType ?? p?.setupType ?? 'opening_range_breakout',
    });
  }
}

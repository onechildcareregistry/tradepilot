import type { AuditRecord, State } from '../domain/models.js';
import { initialState } from '../domain/models.js';
export type Mutation<T> = (state: State, audit: AuditRecord[]) => T;
export interface Repository {
  read(): Promise<State>;
  transact<T>(mutation: Mutation<T>, owner?: string): Promise<T>;
  acquireLease(owner: string, seconds: number): Promise<boolean>;
  releaseLease(owner: string): Promise<void>;
  records(entity: AuditRecord['entity'], before?: string): Promise<AuditRecord[]>;
  pruneObservations(before: string): Promise<void>;
  close(): Promise<void>;
}
export function decodeState(raw: string): State {
  const s: unknown = JSON.parse(raw);
  if (typeof s !== 'object' || s === null || !('version' in s) || s.version !== 1)
    throw new Error('Unsupported state version');
  return s as State;
}
export function projections(before: State, after: State): AuditRecord[] {
  const result: AuditRecord[] = [];
  const add = (entity: AuditRecord['entity'], id: string, at: string, payload: unknown) =>
    result.push({ entity, id, at, payload });
  for (const [date, plan] of Object.entries(after.plans)) {
    if (before.plans[date] && JSON.stringify(before.plans[date]) !== JSON.stringify(plan))
      throw new Error('Approved plans are immutable');
    if (!before.plans[date]) {
      add('TradingPlan', date, plan.generatedAt, plan);
      for (const c of plan.candidates) add('Candidate', `${date}:${c.symbol}`, plan.generatedAt, c);
    }
  }
  const arrays: [
    AuditRecord['entity'],
    { id: string; at?: string; submittedAt?: string }[],
    { id: string }[],
  ][] = [
    ['Order', after.orders, before.orders],
    ['Execution', after.executions, before.executions],
    ['RiskDecision', after.decisions, before.decisions],
    ['StrategySignal', after.signals, before.signals],
    ['CashLedger', after.ledger, before.ledger],
  ];
  for (const [entity, items, old] of arrays)
    for (const item of items) {
      const previous = old.find((x) => x.id === item.id);
      if (JSON.stringify(previous) !== JSON.stringify(item))
        add(
          entity,
          `${item.id}:${'status' in item ? String(item.status) : 'event'}`,
          item.at ?? item.submittedAt ?? new Date().toISOString(),
          item,
        );
    }
  for (const p of after.snapshots.slice(before.snapshots.length))
    add('PortfolioSnapshot', p.at, p.at, p);
  for (const s of after.sessions) {
    const prior = before.sessions.find((x) => x.date === s.date);
    if (JSON.stringify(s) !== JSON.stringify(prior))
      add('TradingSession', `${s.date}:${s.status}`, new Date().toISOString(), s);
  }
  for (const [symbol, p] of Object.entries(after.positions))
    if (JSON.stringify(p) !== JSON.stringify(before.positions[symbol]))
      add(
        'Position',
        `${symbol}:${p.openedAt}:${p.stop}:${p.highWaterPrice}:${p.everHalfR}`,
        new Date().toISOString(),
        p,
      );
  for (const [key, o] of Object.entries(after.outcomes))
    if (JSON.stringify(o) !== JSON.stringify(before.outcomes[key]))
      add(
        'CandidateOutcome',
        `${key}:${o.observations}:${o.triggered}:${o.stopAt}:${o.moveAt}`,
        new Date().toISOString(),
        o,
      );
  for (const item of after.outbox)
    if (JSON.stringify(item) !== JSON.stringify(before.outbox.find((x) => x.id === item.id)))
      add(
        'NotificationOutbox',
        `${item.id}:${item.attempts}:${item.sentAt}`,
        new Date().toISOString(),
        item,
      );
  return result;
}
export class MemoryRepository implements Repository {
  private state: State;
  private audit: AuditRecord[] = [];
  private lease: { owner: string; until: number } | null = null;
  constructor(state = initialState()) {
    this.state = structuredClone(state);
    this.audit = state.ledger.map((item) => ({
      entity: 'CashLedger',
      id: `${item.id}:event`,
      at: item.at,
      payload: item,
    }));
  }
  async read(): Promise<State> {
    return structuredClone(this.state);
  }
  async transact<T>(mutation: Mutation<T>, owner?: string): Promise<T> {
    if (owner && (this.lease?.owner !== owner || this.lease.until <= Date.now()))
      throw new Error('Worker lease lost');
    const next = structuredClone(this.state),
      audit: AuditRecord[] = [];
    const result = mutation(next, audit);
    audit.push(...projections(this.state, next));
    this.state = next;
    for (const row of audit)
      if (!this.audit.some((x) => x.entity === row.entity && x.id === row.id)) this.audit.push(row);
    return result;
  }
  async acquireLease(owner: string, seconds: number): Promise<boolean> {
    if (this.lease && this.lease.until > Date.now() && this.lease.owner !== owner) return false;
    this.lease = { owner, until: Date.now() + seconds * 1000 };
    return true;
  }
  async releaseLease(owner: string): Promise<void> {
    if (this.lease?.owner === owner) this.lease = null;
  }
  async records(entity: AuditRecord['entity'], before?: string): Promise<AuditRecord[]> {
    return structuredClone(
      this.audit.filter((x) => x.entity === entity && (!before || x.at < before)),
    );
  }
  async pruneObservations(before: string): Promise<void> {
    this.audit = this.audit.filter((x) => x.entity !== 'MarketDataSnapshot' || x.at >= before);
  }
  async close(): Promise<void> {}
}

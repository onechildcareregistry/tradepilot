import { planSchema, type TradingPlan, type Session, type Candidate } from '../domain/models.js';
import { D } from '../domain/money.js';
export function validatePlan(input: unknown, session: Session, now: string): TradingPlan {
  const plan = planSchema.parse(input);
  if (plan.tradingDate !== session.date || plan.cutoffAt !== session.cutoffAt)
    throw new Error('Plan date/cutoff mismatch');
  if (plan.generatedAt < session.cutoffAt || plan.generatedAt > now || now > session.open)
    throw new Error('Plan generated outside permitted window');
  if (plan.expiresAt <= session.open || plan.expiresAt > session.entryDeadline)
    throw new Error('Invalid plan expiration');
  const symbols = new Set<string>();
  for (const [index, c] of plan.candidates.entries()) {
    if (symbols.has(c.symbol) || c.rank !== index + 1)
      throw new Error('Duplicate symbol or non-contiguous ranking');
    symbols.add(c.symbol);
  }
  for (const [index, c] of plan.watchlist.entries()) {
    if (symbols.has(c.symbol) || c.rank !== index + 4)
      throw new Error('Duplicate symbol or non-contiguous watchlist ranking');
    symbols.add(c.symbol);
  }
  for (const c of [...plan.candidates, ...plan.watchlist] as Candidate[]) {
    if (D(c.initialTarget).lte(c.triggerPrice)) throw new Error('Target must exceed trigger');
    for (const source of c.sources) {
      if (source.publishedAt && source.publishedAt > session.cutoffAt)
        throw new Error('Post-cutoff source');
      if (source.retrievedAt > now) throw new Error('Future retrieval timestamp');
      if (source.cutoffVerified && !source.publishedAt)
        throw new Error('Unverifiable cutoff claim');
    }
  }
  return plan;
}

import type { TradingBrain } from '../brain/TradingBrain.js';
import type { Clock } from '../domain/Clock.js';
import type { Session } from '../domain/models.js';
import type { Repository } from '../persistence/Repository.js';
import type { ListingDirectory } from '../market-data/ListingDirectory.js';
import { portfolio } from '../portfolio/PortfolioService.js';
import { validatePlan } from '../brain/validation.js';
import { planEmailText } from './ResearchPreview.js';
export class MorningResearchJob {
  constructor(
    private brain: TradingBrain,
    private repo: Repository,
    private clock: Clock,
    private listings: ListingDirectory,
  ) {}
  async run(session: Session, recovery = false): Promise<'skipped' | 'approved' | 'failed'> {
    const now = this.clock.now().toISOString();
    if (now < session.cutoffAt || now >= session.open) return 'skipped';
    const suffix = recovery ? ':recovery' : '';
    const claim = await this.repo.transact((s, audit) => {
      if (recovery && !s.outbox.some((x) => x.id === `research-failed:${session.date}`))
        return false;
      if (s.plans[session.date] || s.outbox.some((x) => x.id === `research-start:${session.date}${suffix}`))
        return false;
      s.outbox.push({
        id: `research-start:${session.date}${suffix}`,
        subject: 'internal-claim',
        text: 'Research job claimed',
        sentAt: now,
        attempts: 0,
      });
      audit.push({
        entity: 'OperationalEvent',
        id: `research-start:${session.date}${suffix}`,
        at: now,
        payload: { status: 'started' },
      });
      return true;
    });
    if (!claim) return 'skipped';
    const state = await this.repo.read();
    const run = await this.brain.generateTradingPlan({
      session,
      startingEquity: portfolio(state, now).equity,
    });
    try {
      if (run.plan) {
        run.plan = validatePlan(run.plan, session, this.clock.now().toISOString());
        const eligible = [];
        for (const c of run.plan.candidates)
          if (await this.listings.eligible(c.symbol, c.exchange)) eligible.push(c);
        run.plan.candidates = eligible.map((c, i) => ({ ...c, rank: i + 1 }));
        const watchlist = [];
        for (const candidate of run.plan.watchlist ?? [])
          if (await this.listings.eligible(candidate.symbol, candidate.exchange)) watchlist.push(candidate);
        run.plan.watchlist = watchlist.map((candidate, index) => ({ ...candidate, rank: index + 4 }));
        if (!run.plan.candidates.length)
          throw new Error('No eligible verified Nasdaq/NYSE common stocks');
        validatePlan(run.plan, session, this.clock.now().toISOString());
      }
    } catch (e) {
      run.validationStatus = 'invalid';
      run.validationErrors.push(e instanceof Error ? e.message : 'Validation failed');
      run.plan = null;
    }
    await this.repo.transact((s, audit) => {
      audit.push({ entity: 'BrainRun', id: run.id, at: run.generatedAt, payload: run });
      if (
        run.validationStatus === 'valid' &&
        run.plan &&
        this.clock.now().toISOString() < session.open
      ) {
        s.plans[session.date] = run.plan;
        const p = run.plan;
        const usage = run.usage;
        s.outbox.push({
          id: `research:${session.date}`,
          subject: `TradePilot research — ${session.date}`,
          text:
            `SIMULATION ONLY | Starting equity: USD ${portfolio(s, now).equity}\nStatus: validated plan; execution remains subject to configuration and risk checks.\n\n` +
            planEmailText(
              p,
              usage?.totalTokens === null || usage?.totalTokens === undefined
                ? 'unavailable'
                : `${usage.totalTokens} total tokens (${usage.inputTokens ?? 'unknown'} input, ${usage.outputTokens ?? 'unknown'} output, ${usage.reasoningTokens ?? 'unknown'} reasoning)`,
            ),
          sentAt: null,
          attempts: 0,
        });
      } else {
        s.outbox.push({
          id: `research-failed:${session.date}${suffix}`,
          subject: `TradePilot no-trade research status — ${session.date}`,
          text:
            run.validationErrors.join('; ') ||
            'Research did not produce a valid plan before the open',
          sentAt: null,
          attempts: 0,
        });
      }
    });
    return run.validationStatus === 'valid' && run.plan ? 'approved' : 'failed';
  }
}

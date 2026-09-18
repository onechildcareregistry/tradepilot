import type { TradingBrain, BrainRun } from '../brain/TradingBrain.js';
import { validatePlan } from '../brain/validation.js';
import type { Clock } from '../domain/Clock.js';
import type { Session } from '../domain/models.js';
import type { ListingDirectory } from '../market-data/ListingDirectory.js';

export async function researchPreview(
  brain: TradingBrain,
  listings: ListingDirectory,
  clock: Clock,
  session: Session,
  startingEquity: string,
): Promise<BrainRun> {
  const run = await brain.generateTradingPlan({ session, startingEquity });
  try {
    if (!run.plan) throw new Error('Research did not produce a plan');
    const eligible = [];
    for (const candidate of run.plan.candidates)
      if (await listings.eligible(candidate.symbol, candidate.exchange)) eligible.push(candidate);
    run.plan.candidates = eligible.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    const watchlist = [];
    for (const candidate of run.plan.watchlist ?? [])
      if (await listings.eligible(candidate.symbol, candidate.exchange)) watchlist.push(candidate);
    run.plan.watchlist = watchlist.map((candidate, index) => ({ ...candidate, rank: index + 4 }));
    if (!run.plan.candidates.length)
      throw new Error('No eligible verified Nasdaq/NYSE common stocks');
    run.plan = validatePlan(run.plan, session, clock.now().toISOString());
    run.validationStatus = 'valid';
  } catch (error) {
    run.validationStatus = 'invalid';
    run.validationErrors = [
      ...run.validationErrors,
      error instanceof Error ? error.message : 'Preview validation failed',
    ];
    run.plan = null;
  }
  return run;
}

export function previewEmailText(run: BrainRun, date: string): string {
  const usage = run.usage;
  const usageText =
    usage?.totalTokens === null || usage?.totalTokens === undefined
      ? 'unavailable'
      : `${usage.totalTokens} total tokens (${usage.inputTokens ?? 'unknown'} input, ${usage.outputTokens ?? 'unknown'} output, ${usage.reasoningTokens ?? 'unknown'} reasoning)`;
  const header = `RESEARCH PREVIEW ONLY — ${date}\nThis was generated before the official 06:15 America/Vancouver cutoff. It is not an approved trading plan, cannot enable execution, and must not be used for orders.\n\nUsage: ${usageText}.\n`;
  if (!run.plan)
    return `${header}\nNo validated preview was produced.\nValidation: ${run.validationErrors.join('; ') || 'unknown failure'}`;
  return (
    `${header}\nMarket regime: ${run.plan.marketRegime}\nMarket regime score: ${run.plan.marketRegimeScore}/100\n\nCandidate review:\n` +
    run.plan.candidates
      .map(
        (candidate) =>
          `${candidate.rank}. ${candidate.symbol} — Explosion ${candidate.explosionScore}; Entry quality ${candidate.entryQuality}\nCatalyst: ${candidate.catalyst}\nPreview trigger: ${candidate.triggerPrice}; invalidation: ${candidate.stopConcept}; suggested target: ${candidate.initialTarget}\nSources: ${candidate.sources.map((source) => source.url).join(', ')}`,
      )
      .join('\n\n') +
      (run.plan.watchlist.length
        ? `\n\nEvaluation watchlist (${run.plan.watchlist.length}; tracked only):\n${run.plan.watchlist.map((candidate) => `${candidate.rank}. ${candidate.symbol}: Explosion ${candidate.explosionScore}; Entry quality ${candidate.entryQuality}\nWhy tracked: ${candidate.watchReason}\nCatalyst: ${candidate.catalyst}`).join('\n\n')}`
        : '')
  );
}

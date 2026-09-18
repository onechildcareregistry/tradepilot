import type { TradingBrain, BrainRun } from '../brain/TradingBrain.js';
import { validatePlan } from '../brain/validation.js';
import type { Clock } from '../domain/Clock.js';
import type { Session } from '../domain/models.js';
import type { Candidate, TradingPlan, WatchlistCandidate } from '../domain/models.js';
import type { ListingDirectory } from '../market-data/ListingDirectory.js';
import { UsTradingCalendar, type TradingCalendar } from '../domain/TradingCalendar.js';

export function previewSession(calendar: TradingCalendar, at: string): Session {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant)) throw new Error('Invalid preview timestamp');
  const today = calendar.date(at);
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000)
      .toISOString().slice(0, 10);
    const session = calendar.session(date);
    if (session && instant < Date.parse(session.open)) return { ...session, cutoffAt: at };
  }
  throw new Error('No upcoming reviewed trading session');
}

export async function researchPreview(
  brain: TradingBrain,
  listings: ListingDirectory,
  clock: Clock,
  session: Session,
  startingEquity: string,
): Promise<BrainRun> {
  const expected = previewSession(new UsTradingCalendar(), clock.now().toISOString());
  if (session.date !== expected.date || session.open !== expected.open)
    throw new Error('Preview must target the next unopened trading session, including today');
  const run = await brain.generateTradingPlan({ session, startingEquity });
  try {
    if (!run.plan) throw new Error('Research did not produce a plan');
    if (clock.now().getTime() >= Date.parse(session.open))
      throw new Error('Preview completed after the target session opened');
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

function unknown(value: string | number | null): string {
  return value === null ? 'Unknown' : String(value);
}
function sources(candidate: Candidate | WatchlistCandidate): string {
  return candidate.sources
    .map(
      (source, index) =>
        `  ${index + 1}. ${source.title}\n     URL: ${source.url}\n     Published: ${unknown(source.publishedAt)} · Retrieved: ${source.retrievedAt} · Cutoff verified: ${source.cutoffVerified}\n     Evidence: ${source.excerpt}`,
    )
    .join('\n');
}
function candidateRecord(candidate: Candidate): string {
  return `${candidate.rank}. ${candidate.symbol} — Explosion ${candidate.explosionScore}; Entry quality ${candidate.entryQuality}\nCompany: ${candidate.company} · ${candidate.exchange} · ${candidate.securityType}\nCatalyst: ${candidate.catalyst}\nCatalyst significance: ${candidate.catalystSignificance}\nPremarket: price ${unknown(candidate.premarket.price)}; change ${unknown(candidate.premarket.changePercent)}%; volume ${unknown(candidate.premarket.volume)}; exhaustion score ${unknown(candidate.premarket.exhaustionScore)}/100\nMarket cap: ${unknown(candidate.marketCap)} · Float shares: ${unknown(candidate.floatShares)}\nSetup: ${candidate.setupType}\nBrain trigger ${candidate.triggerPrice}; structural invalidation: ${candidate.stopConcept}; suggested target ${candidate.initialTarget}; maximum allocation ${(candidate.maximumAllocation * 100).toFixed(0)}%\nReasoning: ${candidate.reasoning}\nConfidence: ${(candidate.confidence * 100).toFixed(0)}%\nUncertainties:\n${candidate.uncertainties.map((item) => `  - ${item}`).join('\n')}\nSources:\n${sources(candidate)}`;
}
function watchlistRecord(candidate: WatchlistCandidate): string {
  return `${candidate.rank}. ${candidate.symbol}: Explosion ${candidate.explosionScore}; Entry quality ${candidate.entryQuality}\nCompany: ${candidate.company} · ${candidate.exchange} · ${candidate.securityType}\nWhy tracked: ${candidate.watchReason}\nCatalyst: ${candidate.catalyst}\nCatalyst significance: ${candidate.catalystSignificance}\nPremarket: price ${unknown(candidate.premarket.price)}; change ${unknown(candidate.premarket.changePercent)}%; volume ${unknown(candidate.premarket.volume)}; exhaustion score ${unknown(candidate.premarket.exhaustionScore)}/100\nMarket cap: ${unknown(candidate.marketCap)} · Float shares: ${unknown(candidate.floatShares)}\nSetup considered: ${candidate.setupType}\nReasoning: ${candidate.reasoning}\nConfidence: ${(candidate.confidence * 100).toFixed(0)}%\nUncertainties:\n${candidate.uncertainties.map((item) => `  - ${item}`).join('\n')}\nSources:\n${sources(candidate)}`;
}
export function planEmailText(plan: TradingPlan, usageText: string): string {
  return `Market regime: ${plan.marketRegime}\nMarket regime score: ${plan.marketRegimeScore}/100\nCutoff: ${plan.cutoffAt}\nPlan expires: ${plan.expiresAt}\n\nRecommended for simulated trading today:\n${plan.candidates.map(candidateRecord).join('\n\n')}${plan.watchlist.length ? `\n\nOthers considered (${plan.watchlist.length}; tracked only, never traded):\n${plan.watchlist.map(watchlistRecord).join('\n\n')}` : ''}\n\nBrain: ${plan.brainVersion} · Prompt: ${plan.promptVersion} · Model: ${plan.model}\nUsage: ${usageText}.`;
}
export function previewEmailText(run: BrainRun, date: string): string {
  if (run.plan && run.plan.tradingDate !== date) throw new Error('Email and plan date mismatch');
  const usage = run.usage;
  const usageText =
    usage?.totalTokens === null || usage?.totalTokens === undefined
      ? 'unavailable'
      : `${usage.totalTokens} total tokens (${usage.inputTokens ?? 'unknown'} input, ${usage.outputTokens ?? 'unknown'} output, ${usage.reasoningTokens ?? 'unknown'} reasoning)`;
  const header = `RESEARCH PREVIEW ONLY — ${date}\nResearch cutoff: ${run.cutoffAt}. This is an on-demand test, not the scheduled morning report. It is not an approved trading plan, cannot enable execution, and must not be used for orders.\n`;
  if (!run.plan)
    return `${header}\nNo validated preview was produced.\nValidation: ${run.validationErrors.join('; ') || 'unknown failure'}`;
  return `${header}\n${planEmailText(run.plan, usageText)}`;
}

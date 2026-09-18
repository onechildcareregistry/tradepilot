import { z } from 'zod';
import { D } from '../domain/money.js';
import type { State } from '../domain/models.js';
import { planSchema } from '../domain/models.js';
import type { Repository } from '../persistence/Repository.js';
import { performance } from './PerformanceService.js';
const num = z.number().finite();
const group = z
  .object({ label: z.string(), tradeCount: z.number().int(), winRate: num.nullable(), pnl: num })
  .strict();
const reportHistoryItem = z
  .object({
    date: z.string(),
    generatedAt: z.string().datetime(),
    marketRegime: z.string(),
    marketRegimeScore: num,
    research: planSchema.optional(),
    candidates: z.array(
      z
        .object({
          rank: z.number().int(),
          symbol: z.string(),
          explosionScore: num,
          entryQuality: num,
          catalyst: z.string(),
          trigger: num,
        })
        .strict(),
    ),
  })
  .strict();
export const publicReportSchema = z
  .object({
    schemaVersion: z.literal(2),
    generatedAt: z.string().datetime(),
    mode: z.literal('Monopoly'),
    fixture: z.boolean(),
    status: z.string(),
    sessionDate: z.string().nullable(),
    coverage: z.string(),
    disclaimer: z.string(),
    metrics: z
      .object({
        equity: num,
        dailyPnl: num,
        cumulativePnl: num,
        dailyReturn: num,
        cumulativeReturn: num,
        realizedPnl: num,
        unrealizedPnl: num,
        maximumDrawdown: num,
        tradeCount: z.number().int(),
        winRate: num.nullable(),
      })
      .strict(),
    equityCurve: z.array(z.object({ at: z.string(), equity: num }).strict()),
    dailyPerformance: z.array(
      z.object({ date: z.string(), pnl: num.nullable(), status: z.string() }).strict(),
    ),
    bySetup: z.array(group),
    byRank: z.array(group),
    reportHistory: z.array(reportHistoryItem),
    priceHistory: z
      .array(
        z
          .object({
            symbol: z.string(),
            start: z.string().datetime(),
            end: z.string().datetime(),
            open: num.positive(),
            high: num.positive(),
            low: num.positive(),
            close: num.positive(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type PublicReport = z.infer<typeof publicReportSchema>;
export function publicReport(s: State, at: string, fixture = false): PublicReport {
  const p = performance(s, at),
    session = s.sessions.at(-1);
  const groups = (items: typeof p.byRank) =>
    items.map((x) => ({
      label: x.label,
      tradeCount: x.tradeCount,
      winRate: x.winRate,
      pnl: x.pnl,
    }));
  return publicReportSchema.parse({
    schemaVersion: 2,
    generatedAt: at,
    mode: 'Monopoly',
    fixture,
    status: s.drawdownHalt ? 'drawdown-halt' : (s.dataIssue ?? session?.status ?? 'waiting'),
    sessionDate: session?.date ?? null,
    coverage: fixture
      ? 'Synthetic fixture — no live market data'
      : 'Finnhub streamed last trades; observed minute ranges; no spread or volume modeling',
    disclaimer:
      'Simulation only. Results do not establish profitability and exclude queue priority and market impact.',
    metrics: {
      equity: p.endingEquity,
      dailyPnl: p.dailyPnl,
      cumulativePnl: p.cumulativePnl,
      dailyReturn: p.dailyReturn,
      cumulativeReturn: p.cumulativeReturn,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: p.unrealizedPnl,
      maximumDrawdown: p.maximumDrawdown,
      tradeCount: p.tradeCount,
      winRate: p.winRate,
    },
    equityCurve: s.snapshots
      .filter((_, i) => i % 5 === 0 || i === s.snapshots.length - 1)
      .map((x) => ({ at: x.at, equity: Number(x.equity) })),
    dailyPerformance: s.sessions.map((x) => ({
      date: x.date,
      pnl: x.endingEquity === null ? null : D(x.endingEquity).sub(x.startingEquity).toNumber(),
      status: x.status,
    })),
    bySetup: groups(p.bySetup),
    byRank: groups(p.byRank),
    reportHistory: Object.values(s.plans)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .map((plan) => ({
        date: plan.tradingDate,
        generatedAt: plan.generatedAt,
        marketRegime: plan.marketRegime,
        marketRegimeScore: plan.marketRegimeScore,
        research: plan,
        candidates: plan.candidates.map((candidate) => ({
          rank: candidate.rank,
          symbol: candidate.symbol,
          explosionScore: candidate.explosionScore,
          entryQuality: candidate.entryQuality,
          catalyst: candidate.catalyst,
          trigger: Number(candidate.triggerPrice),
        })),
      })),
  });
}

/** Explicit public projection: candles only, never decision quotes or operational records. */
export async function persistedPublicReport(repo: Repository, at: string): Promise<PublicReport> {
  const state = await repo.read();
  const report = publicReport(state, at);
  const cutoff = Date.parse(at) - 30 * 86400000;
  const eventSchema = z.object({
    type: z.literal('bar'),
    bar: z.object({
      symbol: z.string(),
      start: z.string().datetime(),
      end: z.string().datetime(),
      open: z.string(),
      high: z.string(),
      low: z.string(),
      close: z.string(),
    }),
  });
  const symbols = new Set(
    Object.values(state.plans).flatMap((p) =>
      [...p.candidates, ...p.watchlist].map((c) => c.symbol),
    ),
  );
  const unique = new Map<string, PublicReport['priceHistory'][number]>();
  for (const row of await repo.records('MarketDataSnapshot')) {
    const parsed = eventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const b = parsed.data.bar;
    if (!symbols.has(b.symbol) || Date.parse(b.start) < cutoff || b.end > at) continue;
    unique.set(`${b.symbol}:${b.start}`, {
      symbol: b.symbol,
      start: b.start,
      end: b.end,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    });
  }
  report.priceHistory = [...unique.values()].sort(
    (a, b) => a.start.localeCompare(b.start) || a.symbol.localeCompare(b.symbol),
  );
  return publicReportSchema.parse(report);
}

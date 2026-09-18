import { z } from 'zod';

export const money = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, 'Positive finite decimal required');
const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export const sourceSchema = z
  .object({
    url: z.string().url(),
    title: z.string(),
    publishedAt: timestamp.nullable(),
    retrievedAt: timestamp,
    cutoffVerified: z.boolean(),
    excerpt: z.string(),
  })
  .strict();
export const candidateSchema = z
  .object({
    rank: z.number().int().min(1).max(3),
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
    company: z.string().min(1),
    exchange: z.enum(['NASDAQ', 'NYSE']),
    securityType: z.literal('common_stock'),
    explosionScore: z.number().min(0).max(100),
    entryQuality: z.number().min(0).max(100),
    catalyst: z.string(),
    catalystSignificance: z.string(),
    premarket: z
      .object({
        price: money.nullable(),
        changePercent: z.number().nullable(),
        volume: z.number().nonnegative().nullable(),
        exhaustionScore: z.number().min(0).max(100).nullable(),
      })
      .strict(),
    marketCap: money.nullable(),
    floatShares: z.number().nonnegative().nullable(),
    triggerPrice: money,
    stopConcept: z.string(),
    initialTarget: money,
    maximumAllocation: z.number().positive().max(0.2),
    setupType: z.literal('opening_range_breakout'),
    reasoning: z.string(),
    sources: z.array(sourceSchema).min(1),
    confidence: z.number().min(0).max(1),
    uncertainties: z.array(z.string()),
  })
  .strict();
export const watchlistCandidateSchema = candidateSchema
  .extend({ rank: z.number().int().min(4).max(15), watchReason: z.string().min(1) })
  .strict();
export const planSchema = z
  .object({
    tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    brainVersion: z.literal('V0.2'),
    promptVersion: z.literal('trading-brain-v0.2'),
    model: z.string().min(1),
    generatedAt: timestamp,
    cutoffAt: timestamp,
    expiresAt: timestamp,
    marketRegime: z.string(),
    candidates: z.array(candidateSchema).min(1).max(3),
    watchlist: z.array(watchlistCandidateSchema).max(12).default([]),
  })
  .strict();
export type TradingPlan = z.infer<typeof planSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type WatchlistCandidate = z.infer<typeof watchlistCandidateSchema>;
export interface Quote {
  symbol: string;
  bid?: string;
  ask?: string;
  lastPrice: string;
  volume?: number;
  timestamp: string;
  receivedAt: string;
  source: string;
  coverage: string;
}
export interface Bar {
  symbol: string;
  start: string;
  end: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number | null;
  receivedAt: string;
  source: string;
}
export type MarketEvent =
  { type: 'quote'; quote: Quote } | { type: 'bar'; bar: Bar } | { type: 'clock'; at: string };
export interface Session {
  date: string;
  open: string;
  close: string;
  entryDeadline: string;
  exitAt: string;
  cutoffAt: string;
}
export interface Signal {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  reason: string;
  at: string;
  trigger?: string;
  stop?: string;
}
export interface Order {
  id: string;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  limit?: string;
  stop?: string;
  submittedAt: string;
  expiresAt: string;
  status: 'pending' | 'filled' | 'canceled';
  reason: string;
  sessionDate: string;
  rank: number;
  setupType: string;
}
export interface Execution {
  id: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: string;
  referencePrice: string;
  fee: string;
  slippage: string;
  at: string;
  source: string;
  coverage: string;
  sessionDate: string;
  rank: number;
  setupType: string;
  realizedPnl: string | null;
  holdingSeconds: number | null;
}
export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: string;
  entryFee: string;
  openedAt: string;
  stop: string;
  initialRisk: string;
  target: string;
  highWaterPrice: string;
  everHalfR: boolean;
  rank: number;
  setupType: string;
}
export interface LedgerEntry {
  id: string;
  at: string;
  amount: string;
  reason: string;
  executionId: string | null;
}
export interface RiskDecision {
  id: string;
  signalId: string;
  at: string;
  approved: boolean;
  reasons: string[];
  checks: Record<string, boolean>;
}
export interface Snapshot {
  at: string;
  equity: string;
  cash: string;
  realizedPnl: string;
  unrealizedPnl: string;
  drawdown: string;
}
export interface SessionRecord {
  date: string;
  status: 'waiting' | 'observing' | 'trading' | 'no-trade' | 'closed' | 'unresolved';
  startingEquity: string;
  endingEquity: string | null;
  reason: string | null;
  config: Record<string, unknown>;
}
export interface CandidateOutcome {
  date: string;
  symbol: string;
  rank: number;
  setupType: string;
  explosionScore: number;
  entryQuality: number;
  exhaustionScore: number | null;
  triggered: boolean;
  stopAt: string | null;
  moveAt: string | null;
  trigger: string | null;
  observedHigh: string | null;
  observedLow: string | null;
  observations: number;
  feed: string;
  actualMovePercent: number | null;
  stopBeforeMove: boolean | null;
}
export interface OutboxItem {
  id: string;
  subject: string;
  text: string;
  sentAt: string | null;
  attempts: number;
}
export interface State {
  version: 1;
  dataIssue?: string;
  maximumDrawdown?: string;
  cash: string;
  realizedPnl: string;
  equityHigh: string;
  drawdownHalt: boolean;
  dailyHalt: boolean;
  session: Session | null;
  sessionStartEquity: string;
  plans: Record<string, TradingPlan>;
  sessions: SessionRecord[];
  orders: Order[];
  executions: Execution[];
  positions: Record<string, Position>;
  ledger: LedgerEntry[];
  decisions: RiskDecision[];
  signals: Signal[];
  quotes: Record<string, Quote>;
  bars: Record<string, Bar[]>;
  processedBars: Record<string, string>;
  snapshots: Snapshot[];
  outcomes: Record<string, CandidateOutcome>;
  outbox: OutboxItem[];
}
export function initialState(): State {
  return {
    version: 1,
    cash: '5000',
    realizedPnl: '0',
    equityHigh: '5000',
    drawdownHalt: false,
    dailyHalt: false,
    session: null,
    sessionStartEquity: '5000',
    plans: {},
    sessions: [],
    orders: [],
    executions: [],
    positions: {},
    ledger: [
      {
        id: 'initial',
        at: '1970-01-01T00:00:00.000Z',
        amount: '5000',
        reason: 'Initial simulated capital',
        executionId: null,
      },
    ],
    decisions: [],
    signals: [],
    quotes: {},
    bars: {},
    processedBars: {},
    snapshots: [],
    outcomes: {},
    outbox: [],
  };
}
export type EntityName =
  | 'TradingSession'
  | 'TradingPlan'
  | 'Candidate'
  | 'BrainRun'
  | 'Order'
  | 'Execution'
  | 'Position'
  | 'PortfolioSnapshot'
  | 'RiskDecision'
  | 'MarketDataSnapshot'
  | 'StrategySignal'
  | 'CashLedger'
  | 'ConfigurationSnapshot'
  | 'SessionCheckpoint'
  | 'NotificationOutbox'
  | 'CandidateOutcome'
  | 'OperationalEvent';
export interface AuditRecord {
  entity: EntityName;
  id: string;
  at: string;
  payload: unknown;
}
export const entities: EntityName[] = [
  'TradingSession',
  'TradingPlan',
  'Candidate',
  'BrainRun',
  'Order',
  'Execution',
  'Position',
  'PortfolioSnapshot',
  'RiskDecision',
  'MarketDataSnapshot',
  'StrategySignal',
  'CashLedger',
  'ConfigurationSnapshot',
  'SessionCheckpoint',
  'NotificationOutbox',
  'CandidateOutcome',
  'OperationalEvent',
];

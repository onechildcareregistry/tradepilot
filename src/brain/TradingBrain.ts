import type { Session, TradingPlan } from '../domain/models.js';
export interface TradingResearchContext {
  session: Session;
  startingEquity: string;
}
export interface BrainRun {
  id: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  startedAt: string;
  generatedAt: string;
  cutoffAt: string;
  originalResearch: unknown;
  originalOutput: unknown;
  validationStatus: 'valid' | 'invalid';
  validationErrors: string[];
  plan: TradingPlan | null;
  usage?: {
    requests: number;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  };
}
export interface TradingBrain {
  generateTradingPlan(context: TradingResearchContext): Promise<BrainRun>;
}

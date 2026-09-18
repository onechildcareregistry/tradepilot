import type { TradingBrain, TradingResearchContext, BrainRun } from './TradingBrain.js';
import type { TradingPlan } from '../domain/models.js';
export class MockTradingBrain implements TradingBrain {
  constructor(private plan: TradingPlan) {}
  async generateTradingPlan(context: TradingResearchContext): Promise<BrainRun> {
    return {
      id: `mock:${context.session.date}`,
      model: 'mock',
      promptVersion: 'trading-brain-v0.2',
      promptHash: 'synthetic-fixture',
      startedAt: this.plan.generatedAt,
      generatedAt: this.plan.generatedAt,
      cutoffAt: context.session.cutoffAt,
      originalResearch: 'Synthetic fixture; no factual stock recommendation',
      originalOutput: structuredClone(this.plan),
      validationStatus: 'valid',
      validationErrors: [],
      plan: structuredClone(this.plan),
    };
  }
}

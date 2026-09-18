import type { MarketEvent, Signal, State } from '../domain/models.js';
export interface StrategyEngine {
  onEvent(state: State, event: MarketEvent): Signal[];
}

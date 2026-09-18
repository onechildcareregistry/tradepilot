import type { Order, Position, Quote, State } from '../domain/models.js';
export interface Broker {
  readonly mode: 'Monopoly' | 'Real';
  getAccount(state: State): { cash: string; currency: 'USD' };
  getPositions(state: State): Position[];
  placeOrder(state: State, order: Order): Order;
  cancelOrder(state: State, orderId: string): void;
  processQuote(state: State, quote: Quote): void;
}

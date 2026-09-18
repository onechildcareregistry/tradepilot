import type { Broker } from './Broker.js';
/** Deliberately no implementation or registration in V1. */
export interface RealBroker extends Broker {
  readonly mode: 'Real';
}

import { randomUUID } from 'node:crypto';
import type { Quote, Bar } from '../domain/models.js';
import type { Config } from '../config.js';
import type { Clock } from '../domain/Clock.js';
import type { TradingCalendar } from '../domain/TradingCalendar.js';
import type { MarketDataProvider } from '../market-data/MarketDataProvider.js';
import type { Repository } from '../persistence/Repository.js';
import type { ReportPublisher } from '../reporting/ReportPublisher.js';
import type { NotificationService } from '../notifications/NotificationService.js';
import { flushNotifications } from '../notifications/NotificationService.js';
import { publicReport } from '../reporting/PublicReport.js';
import { TradingEngine } from './TradingEngine.js';
export class TradingWorker {
  private stop = false;
  private owner = randomUUID();
  constructor(
    private config: Config,
    private repo: Repository,
    private clock: Clock,
    private calendar: TradingCalendar,
    private data: MarketDataProvider,
    private publisher: ReportPublisher,
    private notifications?: NotificationService,
  ) {}
  shutdown(): void {
    this.stop = true;
  }
  async run(): Promise<void> {
    let lastReport = 0,
      lastMinute = '',
      closedDate = '';
    const engine = new TradingEngine(this.repo, this.config, this.owner);
    try {
      while (!this.stop) {
        const now = this.clock.now(),
          at = now.toISOString(),
          session = this.calendar.session(this.calendar.date(at));
        if (!session || at < session.cutoffAt) {
          await this.clock.sleep(30000);
          continue;
        }
        if (!(await this.repo.acquireLease(this.owner, 90))) {
          await this.clock.sleep(15000);
          continue;
        }
        await engine.start(session);
        let state = await this.repo.read();
        if (at >= session.close) {
          if (closedDate !== session.date) {
            this.data.close?.();
            await engine.process({ type: 'clock', at });
            await this.publisher.publish(publicReport(await this.repo.read(), at));
            if (this.notifications)
              await flushNotifications(this.repo, this.notifications, () =>
                this.clock.now().toISOString(),
              );
            closedDate = session.date;
          }
          await this.clock.sleep(30000);
          continue;
        }
        const symbols = [
          ...new Set([
            ...(state.plans[session.date]?.candidates.map((x) => x.symbol) ?? []),
            ...Object.keys(state.positions),
          ]),
        ];
        if (symbols.length && (at >= session.open || this.data.transport === 'stream')) {
          let quotes: Quote[] = [];
          let bars: Bar[] = [];
          let fetchedBars = false;
          let failed = false;
          try {
            quotes = await this.data.getQuotes(symbols);
            const minute = at.slice(0, 16);
            if (minute !== lastMinute) {
              const starts = symbols.map((symbol) => state.processedBars[symbol] ?? session.open);
              const start = starts.sort()[0] ?? session.open;
              bars = await this.data.getBars(symbols, start, at);
              fetchedBars = true;
            }
          } catch (error) {
            failed = true;
            await this.repo.transact((s, audit) => {
              const minute = at.slice(0, 16);
              s.dataIssue = 'data-unavailable';
              for (const order of s.orders)
                if (order.side === 'buy' && order.status === 'pending') order.status = 'canceled';
              audit.push({
                entity: 'OperationalEvent',
                id: `data:${minute}`,
                at,
                payload: {
                  type: 'data-unavailable',
                  message: error instanceof Error ? error.message : 'Failure',
                },
              });
              if (!s.outbox.some((x) => x.id === `data-failure:${session.date}`))
                s.outbox.push({
                  id: `data-failure:${session.date}`,
                  subject: 'TradePilot data interruption',
                  text: 'Market data is unavailable. No fills are fabricated; protective exits await valid observations.',
                  sentAt: null,
                  attempts: 0,
                });
            }, this.owner);
          }
          if (!failed) {
            const freshSymbols = new Set(
              quotes
                .filter(
                  (q) =>
                    Number(q.lastPrice) > 0 &&
                    this.clock.now().getTime() - Date.parse(q.timestamp) >= 0 &&
                    this.clock.now().getTime() - Date.parse(q.timestamp) <=
                      this.config.STALE_SECONDS * 1000,
                )
                .map((q) => q.symbol),
            );
            const issue = this.data.health
              ? this.data.health(symbols)
              : symbols.every((symbol) => freshSymbols.has(symbol))
                ? undefined
                : 'partial-or-stale-data';
            if (state.dataIssue !== issue)
              await this.repo.transact((s) => {
                s.dataIssue = issue;
                if (issue)
                  for (const order of s.orders)
                    if (order.side === 'buy' && order.status === 'pending')
                      order.status = 'canceled';
                if (
                  issue &&
                  at >= new Date(new Date(session.open).getTime() + 60_000).toISOString() &&
                  !s.outbox.some((x) => x.id === `data-stale:${session.date}`)
                )
                  s.outbox.push({
                    id: `data-stale:${session.date}`,
                    subject: 'TradePilot market-data check failed',
                    text: 'No fresh Finnhub prices were received for the planned symbols one minute after the U.S. market opened. New simulated entries are blocked for this session until valid observations return.',
                    sentAt: null,
                    attempts: 0,
                  });
              }, this.owner);
          }
          // Persistence errors escape this loop. They are not treated as recoverable data outages.
          for (const quote of quotes) await engine.process({ type: 'quote', quote });
          for (const bar of bars) await engine.process({ type: 'bar', bar });
          if (fetchedBars) lastMinute = at.slice(0, 16);
        }
        await engine.process({ type: 'clock', at: this.clock.now().toISOString() });
        state = await this.repo.read();
        if (now.getTime() - lastReport >= 300000) {
          await this.publisher.publish(publicReport(state, at));
          lastReport = now.getTime();
          if (this.notifications)
            await flushNotifications(this.repo, this.notifications, () =>
              this.clock.now().toISOString(),
            );
        }
        const seconds =
          this.data.transport === 'stream'
            ? 1
            : at < session.entryDeadline
              ? this.config.POLL_ENTRY_SECONDS
              : Object.keys(state.positions).length
                ? this.config.POLL_POSITION_SECONDS
                : this.config.POLL_IDLE_SECONDS;
        await this.clock.sleep(seconds * 1000);
      }
    } finally {
      this.data.close?.();
      await this.repo.releaseLease(this.owner);
    }
  }
}

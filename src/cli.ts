import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, required } from './config.js';
import { LiveClock } from './domain/Clock.js';
import { UsTradingCalendar, assertTimezoneData } from './domain/TradingCalendar.js';
import { SqliteRepository } from './persistence/SqliteRepository.js';
import { AzureSqlRepository } from './persistence/AzureSqlRepository.js';
import type { Repository } from './persistence/Repository.js';
import { runDemo } from './demo.js';
import { publicReport, persistedPublicReport } from './reporting/PublicReport.js';
import { performance } from './reporting/PerformanceService.js';
import { LocalReportPublisher, AzureReportPublisher } from './reporting/ReportPublisher.js';
import { FinnhubMarketDataProvider } from './market-data/FinnhubMarketDataProvider.js';
import { NasdaqListingDirectory } from './market-data/ListingDirectory.js';
import { HttpClient } from './market-data/HttpClient.js';
import { OpenAiTradingBrain, azureResponsesApi } from './brain/OpenAiTradingBrain.js';
import type { BrainRun } from './brain/TradingBrain.js';
import { planSchema } from './domain/models.js';
import { MorningResearchJob } from './jobs/MorningResearchJob.js';
import { previewEmailText, previewSession, researchPreview } from './jobs/ResearchPreview.js';
import {
  ResendNotificationService,
  flushNotifications,
} from './notifications/NotificationService.js';
import { TradingWorker } from './worker/TradingWorker.js';
function isValidBrainRun(value: unknown): value is BrainRun {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.validationStatus === 'valid' && planSchema.safeParse(record.plan).success;
}
async function main(): Promise<void> {
  assertTimezoneData();
  const c = loadConfig(),
    clock = new LiveClock(),
    calendar = new UsTradingCalendar(c.RESEARCH_HOUR, c.RESEARCH_MINUTE),
    command = process.argv[2] ?? 'status';
  // Cheap schedule guard runs before opening SQL or loading provider credentials.
  const session = calendar.session(calendar.date(clock.now().toISOString()));
  if (
    command === 'research' &&
    (!session ||
      clock.now().toISOString() < session.cutoffAt ||
      clock.now().toISOString() >= session.open ||
      clock.now().getTime() - Date.parse(session.cutoffAt) > 600000)
  ) {
    console.log('Research schedule guard: skipped');
    return;
  }
  let repo: Repository;
  if (command === 'demo')
    repo = new SqliteRepository(process.env.DEMO_DB ?? `data/demo-${randomUUID()}.db`);
  else if (c.DATABASE === 'azure-sql')
    repo = await AzureSqlRepository.connect(
      required(c.SQL_SERVER, 'SQL_SERVER'),
      c.SQL_DATABASE,
      c.AZURE_CLIENT_ID,
    );
  else repo = new SqliteRepository(c.SQLITE_PATH);
  const http = new HttpClient(clock, c.REQUESTS_PER_MINUTE),
    publisher = c.STORAGE_ACCOUNT
      ? new AzureReportPublisher(c.STORAGE_ACCOUNT, c.AZURE_CLIENT_ID)
      : new LocalReportPublisher(c.REPORT_PATH);
  const notifications =
    c.RESEND_API_KEY && c.EMAIL_FROM && c.EMAIL_TO
      ? new ResendNotificationService(c.RESEND_API_KEY, c.EMAIL_FROM, c.EMAIL_TO, http)
      : undefined;
  const provider = () =>
    new FinnhubMarketDataProvider(required(c.FINNHUB_API_KEY, 'FINNHUB_API_KEY'), clock);
  const brain = () => {
    const azure = c.AI_PROVIDER === 'azure-openai';
    const key = azure
      ? required(c.AZURE_OPENAI_API_KEY, 'AZURE_OPENAI_API_KEY')
      : required(c.OPENAI_API_KEY, 'OPENAI_API_KEY');
    const model = azure
      ? required(c.AZURE_OPENAI_DEPLOYMENT, 'AZURE_OPENAI_DEPLOYMENT')
      : required(c.OPENAI_MODEL, 'OPENAI_MODEL');
    return new OpenAiTradingBrain(
      key,
      model,
      clock,
      http,
      c.MAX_RESEARCH_OUTPUT_TOKENS,
      c.RESEARCH_TIMEOUT_SECONDS * 1000,
      azure
        ? azureResponsesApi(required(c.AZURE_OPENAI_ENDPOINT, 'AZURE_OPENAI_ENDPOINT'), key)
        : undefined,
      c.AI_REASONING_EFFORT,
    );
  };
  try {
    if (command === 'demo') {
      const report = await runDemo(repo);
      await new LocalReportPublisher(c.REPORT_PATH).publish(report);
      console.log(JSON.stringify(report, null, 2));
    } else if (command === 'migrate') {
      if (repo instanceof AzureSqlRepository) await repo.migrate();
      console.log('Database schema ready');
    } else if (command === 'status')
      console.log(
        JSON.stringify(publicReport(await repo.read(), clock.now().toISOString()), null, 2),
      );
    else if (command === 'export') {
      const path = resolve(process.argv[3] ?? 'data/private-performance.json');
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(
        path,
        JSON.stringify(performance(await repo.read(), clock.now().toISOString()), null, 2),
      );
      console.log(`Private report written: ${path}`);
    } else if (command === 'verify-data') {
      if (
        !session ||
        clock.now().toISOString() < session.open ||
        clock.now().toISOString() >= session.close
      )
        throw new Error('Run data verification during regular market hours');
      const symbols = (process.argv[3] ?? 'AAPL,IBM').split(',');
      const result = await provider().verify(symbols);
      await repo.transact((_s, a) => {
        a.push({
          entity: 'OperationalEvent',
          id: `verification:${clock.now().toISOString()}`,
          at: clock.now().toISOString(),
          payload: result,
        });
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'research' || command === 'research-recover') {
      if (!session) return;
      const result = await new MorningResearchJob(
        brain(),
        repo,
        clock,
        new NasdaqListingDirectory(),
      ).run(session, command === 'research-recover');
      console.log(result);
      if (notifications)
        await flushNotifications(repo, notifications, () => clock.now().toISOString());
      if (result === 'failed') process.exitCode = 1;
    } else if (command === 'research-preview') {
      if (!notifications) throw new Error('Resend notification configuration is required');
      const preview = previewSession(calendar, clock.now().toISOString());
      const run = await researchPreview(
        brain(),
        new NasdaqListingDirectory(),
        clock,
        preview,
        '5000',
      );
      if (run.validationStatus !== 'valid' || !run.plan) {
        await repo.transact((_state, audit) => {
          audit.push({ entity: 'BrainRun', id: run.id, at: run.generatedAt, payload: run });
        });
        console.log(
          JSON.stringify({
            status: run.validationStatus,
            previewDate: preview.date,
            usage: run.usage,
          }),
        );
        return;
      }
      const item = {
        id: `research-preview:${preview.date}:${run.id}`,
        subject: `TradePilot TEST — research preview for ${preview.date}`,
        text: previewEmailText(run, preview.date),
        sentAt: null,
        attempts: 0,
      };
      await repo.transact((_state, audit) => {
        audit.push({ entity: 'BrainRun', id: run.id, at: run.generatedAt, payload: run });
        audit.push({
          entity: 'OperationalEvent',
          id: item.id,
          at: clock.now().toISOString(),
          payload: { preview: true },
        });
        _state.outbox.push(item);
      });
      await flushNotifications(repo, notifications, () => clock.now().toISOString());
      console.log(
        JSON.stringify({
          status: run.validationStatus,
          previewDate: preview.date,
          usage: run.usage,
        }),
      );
    } else if (command === 'resend-last-preview') {
      if (!notifications) throw new Error('Resend notification configuration is required');
      const run = (await repo.records('BrainRun'))
        .map((record) => record.payload)
        .filter(isValidBrainRun)
        .at(-1);
      if (!run || !run.plan) throw new Error('No prior validated research preview exists');
      const item = {
        id: `research-preview-resend:${randomUUID()}`,
        subject: `TradePilot TEST resend — research preview for ${run.plan.tradingDate}`,
        text: previewEmailText(run, run.plan.tradingDate),
        sentAt: null,
        attempts: 0,
      };
      await repo.transact((state) => state.outbox.push(item));
      await flushNotifications(repo, notifications, () => clock.now().toISOString());
      console.log(JSON.stringify({ subject: item.subject, sent: true }));
    } else if (command === 'worker') {
      const worker = new TradingWorker(
        c,
        repo,
        clock,
        calendar,
        provider(),
        publisher,
        notifications,
      );
      process.once('SIGINT', () => worker.shutdown());
      process.once('SIGTERM', () => worker.shutdown());
      await worker.run();
    } else if (command === 'publish')
      await publisher.publish(await persistedPublicReport(repo, clock.now().toISOString()));
    else if (command === 'archive') {
      if (!(publisher instanceof AzureReportPublisher))
        throw new Error('Archive requires STORAGE_ACCOUNT');
      await publisher.archive(repo, clock.now());
    } else if (command === 'reset-halt') {
      if (c.TRADING_ENABLED)
        throw new Error('Disable trading and stop the worker before resetting a drawdown halt');
      const owner = `admin:${randomUUID()}`;
      if (!(await repo.acquireLease(owner, 30))) throw new Error('Worker still active');
      try {
        await repo.transact((s, a) => {
          s.drawdownHalt = false;
          s.equityHigh = String(performance(s, clock.now().toISOString()).endingEquity);
          a.push({
            entity: 'OperationalEvent',
            id: owner,
            at: clock.now().toISOString(),
            payload: { action: 'manual-drawdown-reset' },
          });
        }, owner);
      } finally {
        await repo.releaseLease(owner);
      }
      console.log('Drawdown baseline reset; trading remains disabled');
    } else
      throw new Error(
        'Commands: demo, status, export, migrate, verify-data, research, research-preview, resend-last-preview, worker, publish, archive, reset-halt',
      );
  } finally {
    await repo.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'TradePilot failed');
  process.exitCode = 1;
});

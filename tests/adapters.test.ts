import { describe, it, expect } from 'vitest';
import { MockClock } from '../src/domain/Clock.js';
import { HttpClient } from '../src/market-data/HttpClient.js';
import {
  FinnhubMarketDataProvider,
  type TradeSocket,
} from '../src/market-data/FinnhubMarketDataProvider.js';
import { NasdaqListingDirectory } from '../src/market-data/ListingDirectory.js';
import { OpenAiTradingBrain, azureResponsesApi } from '../src/brain/OpenAiTradingBrain.js';
import { UsTradingCalendar } from '../src/domain/TradingCalendar.js';
import { samplePlan } from '../src/demo.js';
import { MemoryRepository } from '../src/persistence/Repository.js';
import { MorningResearchJob } from '../src/jobs/MorningResearchJob.js';
import { MockTradingBrain } from '../src/brain/MockTradingBrain.js';
import { TradingEngine } from '../src/worker/TradingEngine.js';
import { loadConfig } from '../src/config.js';
import {
  flushNotifications,
  ResendNotificationService,
} from '../src/notifications/NotificationService.js';
const at = '2026-09-17T13:40:00.000Z';
describe('read-only provider adapters', () => {
  it('subscribes to the trade stream, emits last-price observations, and reconnects after a close', async () => {
    class FakeSocket implements TradeSocket {
      readyState = 0;
      sent: string[] = [];
      closed = false;
      private listeners = new Map<string, Array<(event: Event) => void>>();
      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {
        this.closed = true;
      }
      addEventListener(type: string, listener: (event: Event) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      emit(type: string, data?: string): void {
        if (type === 'open') this.readyState = 1;
        if (type === 'close') this.readyState = 3;
        const event = type === 'message' ? ({ data } as MessageEvent) : new Event(type);
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const clock = new MockClock(new Date(at));
    const sockets: FakeSocket[] = [];
    const provider = new FinnhubMarketDataProvider('private-token', clock, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    await expect(provider.getQuotes(['AAPL'])).rejects.toThrow('stream-connecting');
    const first = sockets[0];
    if (!first) throw new Error('First socket was not created');
    first.emit('open');
    expect(first.sent).toEqual(['{"type":"subscribe","symbol":"AAPL"}']);
    first.emit(
      'message',
      JSON.stringify({ type: 'trade', data: [{ s: 'AAPL', p: 100.25, t: Date.parse(at) }] }),
    );
    expect(await provider.getQuotes(['AAPL'])).toMatchObject([
      { symbol: 'AAPL', lastPrice: '100.25' },
    ]);
    expect(provider.health?.(['AAPL', 'MSFT'])).toBe('partial-or-stale-data:MSFT');
    await clock.sleep(30_000);
    first.emit(
      'message',
      JSON.stringify({
        type: 'trade',
        data: [{ s: 'AAPL', p: 101, t: Date.parse(at) + 30_000 }],
      }),
    );
    await clock.sleep(30_000);
    const completed = await provider.getBars(['AAPL', 'MSFT'], at, clock.now().toISOString());
    expect(completed).toMatchObject([
      { symbol: 'AAPL', open: '100.25', high: '101', low: '100.25', close: '101' },
    ]);
    const repository = new MemoryRepository();
    const engine = new TradingEngine(repository, loadConfig({}));
    const session = new UsTradingCalendar().session('2026-09-17');
    if (!session) throw new Error('Missing session');
    await engine.start(session);
    for (const bar of completed) await engine.process({ type: 'bar', bar });
    expect(await repository.records('MarketDataSnapshot')).toMatchObject([
      { id: `bar:AAPL:${at}`, payload: { type: 'bar', bar: { close: '101' } } },
    ]);
    expect(provider.diagnostics()).toMatchObject({
      connected: true,
      symbols: [{ symbol: 'AAPL', receivedTrades: 2, acceptedTrades: 2 }],
    });
    first.emit('close');
    await clock.sleep(1000);
    await expect(provider.getQuotes(['AAPL'])).rejects.toThrow('stream-disconnected');
    const second = sockets[1];
    if (!second) throw new Error('Reconnect socket was not created');
    second.emit('open');
    expect(second.sent).toEqual(['{"type":"subscribe","symbol":"AAPL"}']);
  });
  it('bounds 429 retries and applies a shared rate budget', async () => {
    let calls = 0;
    const clock = new MockClock(new Date(at));
    const http = new HttpClient(clock, 2, async () => {
      calls++;
      return new Response('', { status: 429 });
    });
    await expect(http.json('https://example.com')).rejects.toThrow('429');
    expect(calls).toBe(3);
    expect(clock.now().getTime() - Date.parse(at)).toBeGreaterThanOrEqual(60000);
  });
  it('rejects ETFs and non-NYSE entries from the listing directory', async () => {
    const directory = new NasdaqListingDirectory(
      async (input) =>
        new Response(
          String(input).includes('nasdaqlisted')
            ? 'Symbol|Security Name|Test Issue|ETF\nAAPL|Apple Common Stock|N|N\nQQQ|Fund|N|Y'
            : 'ACT Symbol|Security Name|Exchange|Test Issue|ETF\nIBM|IBM Common Stock|N|N|N\nOTHER|Other Common Stock|A|N|N',
        ),
    );
    expect(await directory.eligible('AAPL', 'NASDAQ')).toBe(true);
    expect(await directory.eligible('IBM', 'NYSE')).toBe(true);
    expect(await directory.eligible('QQQ', 'NASDAQ')).toBe(false);
    expect(await directory.eligible('OTHER', 'NYSE')).toBe(false);
  });
});
describe('research and notifications', () => {
  it('formats the Azure OpenAI v1 endpoint and uses the api-key header', () => {
    expect(azureResponsesApi('https://example.openai.azure.com/', 'private-key')).toEqual({
      endpoint: 'https://example.openai.azure.com/openai/v1/responses',
      headers: { 'api-key': 'private-key', 'Content-Type': 'application/json' },
      background: true,
    });
    expect(
      azureResponsesApi('https://example.openai.azure.com/openai/v1/', 'private-key').endpoint,
    ).toBe('https://example.openai.azure.com/openai/v1/responses');
  });
  it('polls Azure background responses and retains only the completed responses', async () => {
    const session = new UsTradingCalendar().session('2026-09-17');
    if (!session) throw new Error('No session');
    const plan = samplePlan(session);
    const clock = new MockClock(new Date(plan.generatedAt));
    const requestBodies: Record<string, unknown>[] = [];
    let call = 0;
    const completed = (text: string, tokens: number) => ({
      id: `response-${call}`,
      status: 'completed',
      usage: { input_tokens: tokens, output_tokens: 1, total_tokens: tokens + 1 },
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    });
    const brain = new OpenAiTradingBrain(
      'test',
      'azure-model',
      clock,
      new HttpClient(clock, 180, async (_input, init) => {
        call++;
        if (init?.method === 'POST') {
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
          requestBodies.push(body as Record<string, unknown>);
          return Response.json({ id: `response-${requestBodies.length}`, status: 'queued' });
        }
        if (requestBodies.length === 1)
          return Response.json({
            ...completed('Fixture research', 10),
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Fixture research',
                    annotations: [{ url: 'https://example.com/fixture' }],
                  },
                ],
              },
            ],
          });
        return Response.json(completed(JSON.stringify(plan), 20));
      }),
      undefined,
      600000,
      azureResponsesApi('https://example.openai.azure.com', 'test'),
    );
    const result = await brain.generateTradingPlan({ session, startingEquity: '5000' });
    expect(result.validationStatus).toBe('valid');
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies.every((body) => body.background === true && body.store === true)).toBe(
      true,
    );
    expect(result.usage).toMatchObject({ requests: 2, totalTokens: 32 });
  });
  it('preserves both raw responses and enforces cited evidence', async () => {
    const session = new UsTradingCalendar().session('2026-09-17');
    if (!session) throw new Error('No session');
    const plan = samplePlan(session),
      clock = new MockClock(new Date(plan.generatedAt));
    let request = 0;
    const brain = new OpenAiTradingBrain(
      'test',
      'configured-model',
      clock,
      new HttpClient(clock, 180, async () => {
        request++;
        return Response.json(
          request === 1
            ? {
                status: 'completed',
                usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  total_tokens: 150,
                  output_tokens_details: { reasoning_tokens: 20 },
                },
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: 'Fixture research',
                        annotations: [{ url: 'https://example.com/fixture' }],
                      },
                    ],
                  },
                ],
              }
            : {
                status: 'completed',
                usage: {
                  input_tokens: 80,
                  output_tokens: 40,
                  total_tokens: 120,
                  output_tokens_details: { reasoning_tokens: 10 },
                },
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: JSON.stringify({
                          ...plan,
                          model: 'model-invented-by-response',
                          promptVersion: 'prompt-invented-by-response',
                        }),
                      },
                    ],
                  },
                ],
              },
        );
      }),
    );
    const result = await brain.generateTradingPlan({ session, startingEquity: '5000' });
    expect(result.validationErrors).toEqual([]);
    expect(result.validationStatus).toBe('valid');
    expect(result.originalResearch).not.toBeNull();
    expect(result.originalOutput).not.toBeNull();
    expect(result.plan?.model).toBe('configured-model');
    expect(result.plan?.promptVersion).toBe('trading-brain-v0.2');
    expect(result.usage).toEqual({
      requests: 2,
      inputTokens: 180,
      outputTokens: 90,
      reasoningTokens: 30,
      totalTokens: 270,
    });
  });
  it('records malformed or refused output as invalid', async () => {
    const session = new UsTradingCalendar().session('2026-09-17');
    if (!session) throw new Error('No session');
    const clock = new MockClock(new Date(samplePlan(session).generatedAt)),
      brain = new OpenAiTradingBrain(
        'test',
        'model',
        clock,
        new HttpClient(clock, 180, async () => Response.json({ status: 'completed', output: [] })),
      );
    expect(
      (await brain.generateTradingPlan({ session, startingEquity: '5000' })).validationStatus,
    ).toBe('invalid');
  });
  it('prevents duplicate morning runs and late plans', async () => {
    const session = new UsTradingCalendar().session('2026-09-17');
    if (!session) throw new Error('No session');
    const plan = samplePlan(session),
      repo = new MemoryRepository(),
      clock = new MockClock(new Date(plan.generatedAt)),
      job = new MorningResearchJob(new MockTradingBrain(plan), repo, clock, {
        eligible: async () => true,
      });
    expect(await job.run(session)).toBe('approved');
    expect(await job.run(session)).toBe('skipped');
    clock.set(session.open);
    expect(await job.run(session)).toBe('skipped');
    expect(await repo.records('BrainRun')).toHaveLength(1);
  });
  it('email failure leaves plan intact and retries the same outbox id', async () => {
    const repo = new MemoryRepository();
    await repo.transact((s) => {
      s.outbox.push({ id: 'daily', subject: 'daily', text: 'test', sentAt: null, attempts: 0 });
    });
    await flushNotifications(
      repo,
      {
        sendDailyResearchReport: async () => {
          throw new Error('outage');
        },
      },
      () => at,
    );
    expect((await repo.read()).outbox[0]?.sentAt).toBeNull();
    let id = '';
    await flushNotifications(
      repo,
      {
        sendDailyResearchReport: async (item) => {
          id = item.id;
        },
      },
      () => at,
    );
    expect(id).toBe('daily');
    expect((await repo.read()).outbox[0]?.sentAt).toBe(at);
  });
  it('allows empty research safely and one audited pre-open recovery only', async () => {
    const session = new UsTradingCalendar().session('2026-09-18');
    if (!session) throw new Error('No session');
    const empty = samplePlan(session);
    empty.candidates = [];
    const repo = new MemoryRepository();
    const clock = new MockClock(new Date(empty.generatedAt));
    const job = new MorningResearchJob(new MockTradingBrain(empty), repo, clock, {
      eligible: async () => true,
    });
    expect(await job.run(session, true)).toBe('skipped');
    expect(await job.run(session)).toBe('failed');
    expect(Object.keys((await repo.read()).plans)).toHaveLength(0);
    expect(await job.run(session)).toBe('skipped');
    const good = new MorningResearchJob(new MockTradingBrain(samplePlan(session)), repo, clock, {
      eligible: async () => true,
    });
    expect(await good.run(session, true)).toBe('approved');
    expect(await good.run(session, true)).toBe('skipped');
    const state = await repo.read();
    expect(state.outbox.some((x) => x.id === 'research-failed:2026-09-18')).toBe(true);
    expect(state.outbox.some((x) => x.id === 'research-start:2026-09-18:recovery')).toBe(true);
    clock.set(session.open);
    expect(await good.run(session, true)).toBe('skipped');
  });
  it('includes the current simulated portfolio value in every delivered report', async () => {
    const repo = new MemoryRepository();
    await repo.transact((state) => {
      state.cash = '5123.45';
      state.outbox.push({
        id: 'portfolio',
        subject: 'Status',
        text: 'Body',
        sentAt: null,
        attempts: 0,
      });
    });
    let text = '';
    await flushNotifications(
      repo,
      {
        sendDailyResearchReport: async (item) => {
          text = item.text;
        },
      },
      () => at,
    );
    expect(text).toContain('Current simulated portfolio value: USD 5123.45');
    expect(text).toContain(`As of: ${at}`);
  });
  it('sends a branded HTML report while retaining a plain-text fallback', async () => {
    let body = '';
    const service = new ResendNotificationService(
      'private-key',
      'sender@example.com',
      'recipient@example.com',
      new HttpClient(new MockClock(new Date(at)), 180, async (_url, init) => {
        body = typeof init?.body === 'string' ? init.body : '';
        return Response.json({ id: 'email' });
      }),
    );
    await service.sendDailyResearchReport({
      id: 'preview',
      subject: 'TradePilot TEST — research preview',
      text: 'RESEARCH PREVIEW ONLY — no orders',
      sentAt: null,
      attempts: 0,
    });
    expect(JSON.parse(body)).toMatchObject({
      text: 'RESEARCH PREVIEW ONLY — no orders',
      html: expect.stringContaining('>TradePilot<'),
    });
  });
});

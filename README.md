# TradePilot

A simulation-only intraday U.S. stock experiment. OpenAI proposes a morning plan; deterministic strategy and risk engines decide whether to act; **only the local MockBroker can execute orders**. Starting capital is **US$5,000**, carried between sessions. Nasdaq/NYSE common stocks only, with one to three candidates.

Finnhub supplies free last-trade observations through an outbound WebSocket. V1 uses observed one-minute price ranges and last-price simulated fills with adverse slippage; it does not model spreads or know exchange-wide minute extremes or volume. Simulation results are not evidence of profitability.

## Run locally

Use Node.js **24 LTS** (`nvm use` if available). No credentials are required for the demo or automated tests.

```bash
npm ci
npm run check
npm run demo
npm run dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173). The demo publishes an explicitly labeled synthetic report. Every demo uses a fresh SQLite file under `data/`; it never resets your persistent portfolio. Set `DEMO_DB` to use a specific new database file.

A deterministic fixture produces one round trip and ending equity of **US$5,021.5883**. This is a regression-test result, not a market outcome. The dashboard rounds money for presentation.

```bash
docker build -t tradepilot:local .
docker run --rm tradepilot:local node dist/cli.js demo
# Persistent demo volume:
docker compose run --rm demo
```

## Safety boundary

- `TRADEPILOT_MODE=Monopoly`, `TRADING_ENABLED=false`, and `DATA_VERIFIED=false` are defaults.
- `Real` configuration is rejected before startup. `RealBroker` is only an interface.
- There is no external brokerage order endpoint or order-routing adapter. Finnhub access is restricted to its read-only trade stream.
- All fills happen at a later valid observation. Missing data, halts, and gaps never produce invented fills.
- Disabling entries does not disable protective exits. Unresolved positions persist for next-session liquidation and block new entries until reconciled.
- The public dashboard has no mutation API, credentials, individual trade prices, ticker recommendations, or research evidence.

## Local real-data operation

Copy `.env.example` to `.env` and populate secrets privately. Do not paste API keys into source, reports, or the public dashboard.

1. Create a free Finnhub account and supply `FINNHUB_API_KEY`.
2. Set `AI_PROVIDER=azure-openai`, then supply `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and the Azure deployment name in `AZURE_OPENAI_DEPLOYMENT`. The local default is `tradepilot-gpt-5-6-luna`, which runs `gpt-5.6-luna` (version `2026-07-09`). The adapter uses Azure OpenAI Responses API web search and structured JSON; failures produce an invalid BrainRun and no trades. The first run has no output-token cap and records exact token usage in its private BrainRun record and morning report; set `MAX_RESEARCH_OUTPUT_TOKENS` afterward if desired.
3. Configure Resend's API key, verified sender, and your recipient. For testing, Resend's permitted test sender/recipient combination can be used; general sending requires domain verification.
4. Run `npm run research` within ten minutes of **06:15 America/Vancouver** on a trading day. Outside this window, the command exits without contacting providers or SQL.
5. Run `npm run worker` during market hours with trading disabled to collect observations and reports.
6. During regular hours, run `npm run verify-data -- AAPL,IBM` (replace with the actual candidate symbols). Review timestamp freshness and feed coverage, then complete a full observation-only session.
7. After successful price-access verification and a complete observation-only session, explicitly set `DATA_VERIFIED=true` and `TRADING_ENABLED=true` to enable local simulated orders. Start before 09:30 New York time to capture the opening range. Verification checks fresh last prices, not historical candles.

The plan is immutable once approved. Research can return fewer than three candidates. Ineligible/unknown listings are excluded and the remaining candidates reranked; no eligible candidates or an invalid/late plan means no new trades. Morning research has a durable daily claim, so automatic retries cannot create competing recommendations. If a research process crashes, that day safely remains no-trade; use the next scheduled session rather than rewriting its history.

### Commands

| Command                                         | Purpose                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `npm run demo`                                  | Isolated synthetic day, SQLite persistence, public fixture report     |
| `npm run status`                                | Read sanitized portfolio/session status                               |
| `npm run worker`                                | Continuous intraday processing; SIGINT/SIGTERM clean shutdown         |
| `npm run research`                              | Finite, guarded morning research job                                  |
| `npm run verify-data -- SYMBOL1,SYMBOL2`        | Live free-feed capability/freshness check                             |
| `npm run migrate`                               | Create database schema; use the SQL administrator identity initially  |
| `npm run admin -- export data/performance.json` | Private performance export, including per-ticker/outcome data         |
| `npm run admin -- publish`                      | Publish sanitized report                                              |
| `npm run admin -- archive`                      | Archive old market observations before SQL deletion                   |
| `npm run admin -- reset-halt`                   | Reset drawdown baseline only with trading disabled and worker stopped |
| `npm run schema`                                | Regenerate the committed TradingPlan JSON schema                      |
| `npm run infra:check`                           | Compile Bicep without deploying resources                             |

## Deterministic execution

Opening range uses exactly five contiguous completed one-minute bars from 09:30 to 09:35 New York time. The trigger is the greater of the range high and the Brain trigger. Two consecutive completed one-minute closes above the trigger confirm an entry before 11:00. Missing bars block entry; late bar corrections do not rewrite past decisions.

Defaults are centralized in `src/config.ts`:

| Rule                                      | Default                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Entry Quality minimum                     | 60/100                                                                             |
| Chase maximum                             | 0.5% above trigger; no spread check                                                |
| Stop                                      | Opening-range low, no more than 5% below entry                                     |
| Risk budget                               | 0.5% of session-start equity, including configured entry/exit fees                 |
| Allocation / exposure                     | 20% per candidate / 60% total, including reserved pending entries                  |
| Positions / entries                       | 3 positions / 1 filled entry per symbol per session                                |
| Target                                    | Entire position at 2R based on actual fill                                         |
| Trail                                     | After +1R, raise to lowest low of last two completed post-entry bars; never loosen |
| Time invalidation                         | 30 minutes without ever observing +0.5R                                            |
| Session liquidation                       | 5 minutes before scheduled close, including early closes                           |
| Daily loss / drawdown                     | 2% of session-start equity / 10% from recorded equity high                         |
| Entry quote freshness / pending entry TTL | 15 seconds / 30 seconds                                                            |
| Slippage / commissions                    | 5 basis points adverse / zero per order, configurable                              |

Entries are marketable limit orders capped by the chase limit and sized against the worst allowed fill. Fills use the next eligible observed last price plus adverse slippage. Full fills only; no queue, partial-fill, market-impact, settlement, or broker-specific regulatory model. Sales reuse simulated cash immediately. All arithmetic for balances and execution uses decimal.js.

Loss checks cancel pending entries and request liquidation. The drawdown halt remains latched until a private reset. Stops and risk exits take precedence over targets. The full sell path remains available without an active/valid research plan.

## Architecture and persistence

```text
TradingBrain → immutable TradingPlan
MarketDataProvider + Clock → MarketEvent → StrategyEngine
  → RiskEngine → OrderManager → MockBroker → portfolio + transactional persistence
                                         → sanitized public report
```

The strategy consumes quotes, completed bars, and clock events; it does not import HTTP, timers, Azure, or an AI SDK. A future replay provider and simulation clock can reuse the engine. The broker is synchronous inside a transaction in V1; a future real broker will require an asynchronous durable outbox/reconciliation implementation rather than network calls inside that transaction.

Adapters: in-memory (tests), SQLite/WAL (local), Azure SQL (deployed). The durable state document provides atomic restart checkpoints; append-only entity tables preserve domain transitions and raw evidence. SQL uses serializable transactions and a database-time worker lease. SQLite uses immediate transactions. A lost lease or persistence error stops processing rather than continuing with uncommitted state.

Audited entities include sessions, plans, candidates, BrainRuns, orders, executions, positions, portfolio snapshots, risk decisions, market snapshots, signals, cash ledger, configuration, checkpoints, notification outbox, and candidate outcomes. Positions in the state document are authoritative current positions; the Position audit table contains historical versions.

Raw market events remain in SQL for 30 days, then archive as compressed private blobs; blob expiry 60 days after archiving gives approximately 90 days of total retention. Archival must complete before SQL pruning. Original plans, evidence, financial ledger, and derived outcomes are retained. Monitor the Basic SQL 2 GB limit; the initial design targets three candidates, not a large universe.

Performance includes daily/cumulative returns, realized/unrealized P&L, trade statistics, drawdown, holding time, per-ticker/setup/rank results, slippage, and observed candidate outcomes. Explosion/Entry Quality/exhaustion are retained next to measured outcomes for analysis. Unobservable stop-before-move ordering is null. All path metrics describe sampled observations, not a complete market tape.

## Research cutoff and timezones

The Brain starts at 06:15 Vancouver and filters out evidence explicitly published after that cutoff. It retains citation URLs, model evidence, original structured response, prompt hash/version, and validation results. Retrieved web pages are not historical snapshots: source timing remains explicitly unverified unless independently established. No claim of look-ahead-free research is made.

Timezone data is pinned through `moment-timezone@0.6.2` and startup asserts that Vancouver stays UTC−7 in December 2026. New York still changes offsets. The reviewed NYSE calendar covers **2026–2027** and fails closed outside it. Review emergency market closures operationally and update the calendar when needed.

Sources: [NYSE sessions](https://www.nyse.com/trade/hours-calendars), [B.C. time change](https://archive.news.gov.bc.ca/releases/news_releases_2024-2028/2026AG0013-000209.pdf), [Finnhub quote API](https://finnhub.io/docs/api/quote), [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search).

## Azure deployment

See [the deployment runbook](docs/deployment.md). Bicep provisions the foundation first, allowing SQL identity bootstrapping and Key Vault secret setup before applications reference those resources. Azure Functions are not used.

The dashboard is global static content, with Static Web Apps control-plane location East US 2. SQL, Container Apps, storage, and Key Vault default to Canada Central. The runtime uses managed identity and Entra-only SQL authentication.

The under-US$10 monthly Azure target assumes a small experiment, free Container Apps grants available to this subscription, limited logs/storage, public GHCR image hosting, and no paid networking additions. SQL Basic was quoted at US$0.177/day in Canada Central on 2026-09-17. Budget alerts do **not** stop billing; budget amounts use the subscription's billing currency. OpenAI usage is separate.

## Verification

`npm run check` runs strict TypeScript, lint (including no explicit `any` or non-null assertions), deterministic tests, and production builds. Tests cover the strategy, accounting, plan validation, data quota handling, provider boundaries, persistence rollback/restart, worker leases, and public-report allowlisting.

An Azure SQL integration test is opt-in through `SQL_TEST_SERVER` and `SQL_TEST_DATABASE`; use an empty, dedicated test database and an authorized administrator identity. Never point it at the production portfolio. API and deployed Azure checks require your accounts and are distinct from mocked contract tests.

### SQL Server adapter tests with Docker

```bash
docker compose -f docker-compose.test.yml up -d
# Once SQL Server reports ready for client connections:
npm run test:sql
docker compose -f docker-compose.test.yml down
```

The test service binds only to loopback and uses an explicitly test-only password. Each test creates and drops its own database; production always uses managed identity. These exercise the same repository contracts against actual SQL Server, while the optional Azure test verifies the cloud authentication path separately.

### Finnhub V1 transport and observed ranges

V1 holds one outbound Finnhub WebSocket and subscribes to the selected symbols. This is streaming, not a webhook: no public endpoint is exposed. The worker reconnects with bounded exponential backoff and resubscribes after a disconnect. It does not silently fall back to REST polling. A connection, provider, protocol, buffer, or data-freshness failure marks the session unhealthy, cancels pending buys, and prevents new entries until fresh trade updates arrive again.

One-minute bars contain only the last trades actually received during an uninterrupted stream connection. Source timestamps remain on raw observations and must be no more than 15 seconds old. These are **observed price ranges, not exchange OHLCV**. Volume remains null. A disconnect discards every uncompleted minute; restarts do the same. Missing opening-range minutes make that symbol no-trade for that day. Price extremes that Finnhub does not deliver cannot be inferred.

Completed bars, orders, positions, and observations are persisted. Opening-range entries require all five observed opening minutes and two consecutive confirming minutes. Later missing minutes delay confirmation or trailing-stop updates; protective last-price exits remain active when valid trade updates resume. `PRICE_MODEL=last-price-v1` is recorded with each configuration snapshot. Both fill directions, mark-to-market, stops, targets, and exposure checks use last price. Fills require a subsequent source timestamp; repeated trade updates with the same timestamp cannot fill an order.

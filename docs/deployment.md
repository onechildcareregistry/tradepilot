# Deployment and operations

## Prerequisites

- Azure subscription, Azure CLI/Bicep, Node 24, and Docker.
- Azure permissions to create a resource group, resources, role assignments, and an Entra SQL administrator.
- A GitHub repository for this project and an immutable **public** GHCR image. The included image workflow builds Linux/amd64 on GitHub Actions. If building on Apple Silicon for Azure, use `docker buildx build --platform linux/amd64`.
- An Azure OpenAI resource with a `gpt-5.6-luna` deployment (version `2026-07-09`), its endpoint/key, Finnhub free API key, and Resend key/sender/recipient. Secrets never go into parameter JSON, source control, or the public report.

## 1. Validate and publish artifacts

```bash
npm ci
npm run check
npm run infra:check
```

Push this repository to your chosen GitHub remote and manually run **Publish worker image**. Make the GHCR package public (container images contain application code, not secrets). Use its commit tag, not a mutable `latest` tag.

Copy `infra/parameters.example.json` to an ignored local parameter file; replace every placeholder. Use the first day of the current month for `budgetStartDate`. Keep `deployApplications`, `tradingEnabled`, and `dataVerified` false.

## 2. Deploy only the foundation

```bash
az deployment sub create --name tradepilot-foundation --location canadacentral \
  --template-file infra/main.bicep --parameters @infra/parameters.local.json
```

Record outputs for SQL server, managed identity principal ID, Key Vault, Static Web Apps name, dashboard URL, and report URL. Foundation deployment creates billable SQL immediately; review the cost estimate first. Budget alerts use the subscription's billing currency, not automatically USD.

## 3. Bootstrap the database and secrets

Authenticate with the configured SQL administrator via `az login`. Add a temporary SQL firewall rule for your local public IP if needed, then set `SQL_SERVER`, `SQL_DATABASE`, `RUNTIME_PRINCIPAL_ID`, and `RUNTIME_CLIENT_ID` locally. Run:

```bash
npx tsx scripts/bootstrap-sql.ts
```

The script creates the schema and maps the runtime identity to database reader/writer roles using its principal ID. It does not grant schema-changing rights to the worker. Remove temporary local-IP access afterward.

The Azure-services SQL firewall rule permits network reachability from Azure; Entra authentication and database roles still enforce access. This avoids paid private networking in the initial experiment.

Use Key Vault's portal or securely supplied CLI input to create these secrets:

- `azure-openai-api-key`
- `finnhub-api-key`
- `resend-api-key`

For local development, after Azure CLI sign-in, provision the configured Astra endpoint and write its key to the ignored `.env` without displaying it:

```bash
npm run configure:azure-openai
```

The deploying user needs Key Vault secret-writing permission; the application identity is granted only secret-reading permission. Do not print secret values in logs or commit them to parameter files.

## 4. Deploy applications, still disabled

```bash
az deployment sub create --name tradepilot-runtime --location canadacentral \
  --template-file infra/main.bicep --parameters @infra/parameters.local.json \
  --parameters deployApplications=true
```

The worker has no ingress. One scheduled KEDA replica runs weekdays 08:00–16:10 New York time; the calendar handles holidays and early closes inside the app. Outside that window it scales to zero. After cleanup the process waits, preventing container restart loops.

The research job receives two UTC opportunities, 13:15 and 14:15. The application accepts only the first ten minutes after configured 06:15 Vancouver time and uses a durable daily claim. The second opportunity is a cheap no-op under the current UTC−7 rules. Update both cron opportunities and application configuration when changing research time; never assume New York and Vancouver share DST changes.

The archive job runs weekdays at 21:30 UTC. It uploads old observations before deleting them from SQL. A failure leaves SQL data intact.

## 5. Publish dashboard

Set repository variable `TRADEPILOT_REPORT_URL` to the deployment's public blob report URL. Store the Static Web Apps deployment token as GitHub secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. Run **Publish public dashboard**. The workflow removes the local demo report and builds only static assets. No Functions backend is included.

Before the first real report, the dashboard shows an unavailable/waiting state. The public container exposes only sanitized reports. The archive container and SQL remain private. Reports update every five minutes during worker operation and at session close; the UI refreshes every minute and marks reports older than ten minutes as potentially stale.

## 6. Observe, then explicitly enable

Leave entries disabled for a full session. Verify actual selected symbols with `verify-data`, review observations and missing-data behavior, and inspect email/report delivery. Only then deploy with `dataVerified=true` and `tradingEnabled=true`.

New replicas must acquire the database lease before processing. Changes in configuration are captured per session. To disable new entries, redeploy with `tradingEnabled=false`; the worker continues protective exits while market data is valid.

## Recovery

- **Data outage/halt:** pending exits remain pending; no stale/fabricated fill. At close, unresolved positions remain on the ledger and reconcile next session before new entries.
- **Worker crash:** restart with the same database. The lease expires; state, pending orders, bar checkpoints, cash, and positions resume atomically.
- **Database outage:** worker stops processing. Restore connectivity before restart. Never replace it with a fresh database to hide a failure.
- **Late/invalid research:** no new trades; retain the BrainRun and failure email. Do not rewrite historical plans.
- **Research crash after claim:** no duplicate run that day. Inspect private logs; resume normal scheduling next day.
- **Email outage:** outbox retries with a stable idempotency key, up to five attempts; inspect the private outbox after exhaustion.
- **Drawdown halt:** stop the worker, disable entries, review private records, then run `reset-halt`. This records an explicit baseline reset and does not enable trading.
- **Calendar expiry:** add reviewed exchange dates and timezone regression tests before running a new year.

## Cost controls

A 23-weekday month at 0.25 vCPU / 0.5 GiB for 8h10m/day is approximately 169,050 vCPU-seconds and 338,100 GiB-seconds before job startup, scale-down cooldown, and retries. Compare this with the subscription-wide free grants; other applications consume the same grants. SQL Basic is approximately US$5.49 in a 31-day month at the observed Canada Central rate. Storage, logs, secret operations, and grant overages remain variable.

Log Analytics ingestion is capped at 0.05 GB/day with 30-day retention. Alerts at 50%, 80%, and 100% of a 10-unit monthly budget are informational, not a spending stop. Monitor SQL's 2 GB capacity and archive-job failures. Do not add ACR, NAT Gateway, private endpoints, or always-on replicas without revisiting the budget.

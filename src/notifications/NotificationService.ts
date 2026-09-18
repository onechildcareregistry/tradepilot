import type { OutboxItem } from '../domain/models.js';
import type { Repository } from '../persistence/Repository.js';
import { HttpClient } from '../market-data/HttpClient.js';
import { portfolio } from '../portfolio/PortfolioService.js';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ??
      character,
  );
}

function emailHtml(item: OutboxItem): string {
  const preview = /preview/i.test(item.subject) || /PREVIEW ONLY/.test(item.text);
  const status = preview ? 'Research preview' : 'Morning research report';
  return `<!doctype html>
<html><body style="margin:0;background:#f3f6fb;font-family:Arial,sans-serif;color:#172033">
  <main style="max-width:680px;margin:32px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #dfe6f2">
    <header style="padding:28px 32px;background:#102a43;color:#ffffff">
      <div style="font-size:28px;font-weight:700;letter-spacing:-.5px">TradePilot</div>
      <div style="margin-top:6px;font-size:14px;color:#cbd9e8">Simulation-only U.S. equity research</div>
    </header>
    <section style="padding:28px 32px">
      <div style="display:inline-block;padding:6px 10px;border-radius:999px;background:${preview ? '#fff4d6' : '#e2f4ea'};color:${preview ? '#7a4b00' : '#17643d'};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">${status}</div>
      <h1 style="margin:18px 0 8px;font-size:22px;line-height:1.3">${escapeHtml(item.subject)}</h1>
      <div style="margin-top:20px;padding:20px;background:#f7f9fc;border-radius:10px;white-space:pre-wrap;font-size:15px;line-height:1.6">${escapeHtml(item.text)}</div>
    </section>
    <footer style="padding:18px 32px;border-top:1px solid #dfe6f2;color:#5c6b7d;font-size:12px;line-height:1.5">Simulation only. This report is not investment advice and does not establish profitability.</footer>
  </main>
</body></html>`;
}
export interface NotificationService {
  sendDailyResearchReport(item: OutboxItem): Promise<void>;
}
export class ResendNotificationService implements NotificationService {
  constructor(
    private apiKey: string,
    private from: string,
    private to: string,
    private http: HttpClient,
  ) {}
  async sendDailyResearchReport(item: OutboxItem): Promise<void> {
    await this.http.json('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': item.id,
      },
      body: JSON.stringify({
        from: this.from,
        to: [this.to],
        subject: item.subject,
        text: item.text,
        html: emailHtml(item),
      }),
    });
  }
}
export async function flushNotifications(
  repo: Repository,
  service: NotificationService,
  now: () => string,
): Promise<void> {
  const state = await repo.read(),
    reportedAt = now(),
    currentValue = portfolio(state, reportedAt).equity;
  for (const item of state.outbox.filter((x) => !x.sentAt && x.attempts < 5)) {
    try {
      await service.sendDailyResearchReport({
        ...item,
        text: `Current simulated portfolio value: USD ${currentValue}\nAs of: ${reportedAt}\n\n${item.text}`,
      });
      await repo.transact((s) => {
        const target = s.outbox.find((x) => x.id === item.id);
        if (target) {
          target.sentAt = reportedAt;
          target.attempts++;
        }
      });
    } catch {
      await repo.transact((s) => {
        const target = s.outbox.find((x) => x.id === item.id);
        if (target) target.attempts++;
      });
    }
  }
}

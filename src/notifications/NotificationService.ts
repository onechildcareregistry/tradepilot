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

function reportSections(text: string): { portfolioValue: string; reportedAt: string; sections: string[] } {
  const match = text.match(
    /^Current simulated portfolio value: USD ([^\n]+)\nAs of: ([^\n]+)\n\n([\s\S]*)$/,
  );
  const body = match?.[3] ?? text;
  return {
    portfolioValue: match?.[1] ?? 'Unavailable',
    reportedAt: match?.[2] ?? 'Unavailable',
    sections: body.split(/\n(?=\d+\. [A-Z][A-Z.\-]+:)/).filter(Boolean),
  };
}

function sectionHtml(section: string): string {
  const [heading = '', ...details] = section.split('\n');
  const candidate = heading.match(/^(\d+\. [A-Z][A-Z.\-]+): (.*)$/);
  if (!candidate)
    return `<section style="margin:20px 0;padding:18px 20px;background:#f5f7fa;border-radius:4px;color:#4c5b70;font-size:15px;line-height:1.65">${escapeHtml(section).replace(/\n/g, '<br>')}</section>`;
  return `<section style="padding:24px 0;border-top:1px solid #dde3eb">
    <div style="font-size:22px;line-height:1.25;font-weight:700;color:#182235">${escapeHtml(candidate[1] ?? '')} <span style="font-size:14px;color:#158060">${escapeHtml(candidate[2] ?? '')}</span></div>
    <div style="margin-top:12px;color:#4c5b70;font-size:15px;line-height:1.65">${escapeHtml(details.join('\n')).replace(/\n/g, '<br>')}</div>
  </section>`;
}

function emailHtml(item: OutboxItem): string {
  const preview = /preview/i.test(item.subject) || /PREVIEW ONLY/.test(item.text);
  const status = preview ? 'Research preview' : 'Morning research report';
  const report = reportSections(item.text);
  return `<!doctype html>
<html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#182235">
  <main style="max-width:680px;margin:32px auto;background:#ffffff;overflow:hidden">
    <header style="padding:34px 40px;background:#172238;color:#ffffff">
      <div style="font-size:13px;font-weight:700;letter-spacing:.6px;color:#b7c3d6;text-transform:uppercase">${status}</div>
      <div style="margin-top:12px;font-size:31px;line-height:1.15;font-weight:700">TradePilot</div>
      <div style="margin-top:10px;font-size:16px;line-height:1.4;color:#d4dcea">${escapeHtml(item.subject)}</div>
    </header>
    <section style="padding:32px 40px">
      <div style="font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#6e7d92">Portfolio snapshot</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;background:#f4f6f9">
        <tr><td style="padding:20px 22px;width:50%;vertical-align:top"><div style="font-size:14px;color:#65748a">Portfolio value</div><div style="margin-top:7px;font-size:27px;font-weight:700;color:#182235">USD ${escapeHtml(report.portfolioValue)}</div></td><td style="padding:20px 22px;vertical-align:top"><div style="font-size:14px;color:#65748a">Report time</div><div style="margin-top:8px;font-size:14px;font-weight:700;line-height:1.45;color:#182235">${escapeHtml(report.reportedAt)}</div></td></tr>
      </table>
      <div style="margin-top:32px;font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#6e7d92">Today's research</div>
      <div style="margin-top:16px">${report.sections.map(sectionHtml).join('')}</div>
    </section>
    <footer style="padding:20px 40px;background:#f4f6f9;color:#718096;font-size:12px;line-height:1.55">Simulation only. This report is not investment advice and does not establish profitability.</footer>
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

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

interface EmailCandidate {
  rank: string;
  symbol: string;
  explosion: string;
  quality: string;
  catalyst: string;
  trigger: string | null;
  invalidation: string | null;
  suggestedTarget: string | null;
  note: string | null;
}
function candidates(text: string): EmailCandidate[] {
  const headings = [
    ...text.matchAll(/^(\d+)\. ([A-Z][A-Z.\-]+)\s*(?:—|:)\s*Explosion (\d+); Entry quality (\d+)/gm),
  ];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? text.length;
    const details = text.slice(start, end);
    return {
      rank: heading[1] ?? '',
      symbol: heading[2] ?? '',
      explosion: heading[3] ?? '',
      quality: heading[4] ?? '',
      catalyst: details.match(/Catalyst: ([^\n]+)/)?.[1] ?? 'No catalyst summary recorded.',
      trigger: details.match(/(?:Brain|Preview) trigger: ([^;\n]+)/)?.[1] ?? null,
      invalidation: details.match(/invalidation: ([^;\n]+)/)?.[1] ?? null,
      suggestedTarget: details.match(/suggested target:?\s*([^;\n]+)/)?.[1] ?? null,
      note: details.match(/Why tracked: ([^\n]+)/)?.[1] ?? null,
    };
  });
}
function reportData(text: string) {
  const match = text.match(
    /^Current simulated portfolio value: USD ([^\n]+)\nCash: USD ([^\n]+)\nOpen positions: ([^\n]+)\nAs of: ([^\n]+)\n\n([\s\S]*)$/,
  );
  const body = match?.[5] ?? text,
    [primary = '', watch = ''] = body.split(/(?:Evaluation watchlist|Others considered)[^\n]*:\n/);
  return {
    portfolioValue: match?.[1] ?? 'Unavailable',
    cash: match?.[2] ?? 'Unavailable', positions: match?.[3] ?? 'None', reportedAt: match?.[4] ?? 'Unavailable',
    regime: body.match(/(?:Market )?[Rr]egime: ([^\n]+)/)?.[1] ?? null,
    regimeScore: body.match(/Market regime score: (\d+)\/100/)?.[1] ?? null,
    brain: body.match(/Brain: ([^\n·]+)(?: · Prompt: [^\n·]+)? · Model: ([^\n]+)/),
    promptVersion: body.match(/ · Prompt: ([^\n·]+)/)?.[1]?.trim() ?? 'Unavailable',
    usage: body.match(/Usage: ([^\n]+)/)?.[1] ?? null,
    fullRecord: body,
    recommendations: candidates(primary).filter((candidate) => Number(candidate.rank) <= 3),
    watchlist: candidates(watch),
  };
}
function recommendationHtml(candidate: EmailCandidate): string {
  const lead = candidate.rank === '1';
  return `<section style="margin-top:12px;padding:${lead ? '22px' : '17px 20px'};background:#ffffff;border:1px solid ${lead ? '#93b7ab' : '#d7e0e9'};border-left:5px solid ${lead ? '#168060' : '#536f95'};border-radius:6px">
    <div style="font-size:${lead ? '25px' : '19px'};font-weight:700;color:#172238"><span style="display:inline-block;margin-right:9px;padding:3px 7px;background:${lead ? '#168060' : '#536f95'};color:#ffffff;border-radius:3px;font-size:12px;vertical-align:middle">#${escapeHtml(candidate.rank)}</span>${escapeHtml(candidate.symbol)}</div>
    <div style="margin-top:9px;font-size:12px;font-weight:700;color:#168060">RECOMMENDED SETUP · Explosion ${escapeHtml(candidate.explosion)}/100 · Entry quality ${escapeHtml(candidate.quality)}/100</div>
    <div style="margin-top:9px;color:#405068;font-size:${lead ? '15px' : '14px'};line-height:1.55"><b>Catalyst:</b> ${escapeHtml(candidate.catalyst)}</div>
    ${candidate.trigger ? `<div style="margin-top:13px;padding:12px;background:#f4f6f9;border-radius:4px;font-size:12px;line-height:1.55;color:#536174"><div style="font-size:10px;font-weight:700;letter-spacing:.4px;color:#718096;text-transform:uppercase">Brain research reference</div><div style="margin-top:5px"><b>Proposed trigger:</b> USD ${escapeHtml(candidate.trigger)}</div>${candidate.invalidation ? `<div><b>Structural invalidation:</b> ${escapeHtml(candidate.invalidation)}</div>` : ''}${candidate.suggestedTarget ? `<div><b>Suggested target:</b> USD ${escapeHtml(candidate.suggestedTarget)}</div>` : ''}</div><div style="margin-top:9px;font-size:11px;color:#718096">Execution independently requires opening-range confirmation and risk approval. The simulation uses the opening-range low as its stop and a 2R target.</div>` : ''}
  </section>`;
}
function consideredHtml(candidate: EmailCandidate, position: number): string {
  return `<div style="margin-top:8px;padding:10px 0;border-top:1px solid #e2e7ed;color:#718096;font-size:12px;line-height:1.45"><b style="color:#536174">${position}. ${escapeHtml(candidate.symbol)}</b> <span>· considered, not recommended · Explosion ${escapeHtml(candidate.explosion)}/100 · Entry quality ${escapeHtml(candidate.quality)}/100</span><br><span>${escapeHtml(candidate.note ?? candidate.catalyst)}</span></div>`;
}

function emailHtml(item: OutboxItem): string {
  const preview = /preview/i.test(item.subject) || /PREVIEW ONLY/.test(item.text);
  const status = preview ? 'Research preview' : 'Morning research report';
  const report = reportData(item.text);
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
        <tr><td style="padding:20px 22px;width:50%;vertical-align:top"><div style="font-size:14px;color:#65748a">Portfolio value</div><div style="margin-top:7px;font-size:27px;font-weight:700;color:#182235">USD ${escapeHtml(report.portfolioValue)}</div><div style="margin-top:8px;font-size:12px;color:#607087">Cash USD ${escapeHtml(report.cash)} · Open positions: ${escapeHtml(report.positions)}</div></td><td style="padding:20px 22px;vertical-align:top"><div style="font-size:14px;color:#65748a">Market conditions</div><div style="margin-top:8px;font-size:16px;font-weight:700;line-height:1.4;color:#182235">${escapeHtml(report.regime ?? 'Not recorded')}</div><div style="margin-top:7px;font-size:12px;color:#168060">${report.regimeScore ? `Regime confidence ${escapeHtml(report.regimeScore)}/100` : 'Regime confidence unavailable'}</div></td></tr>
      </table>
      <div style="margin-top:32px;font-size:13px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#168060">Recommended for simulated trading today</div>
      <div style="margin-top:7px;font-size:13px;color:#536174">Only the ranked setups below can be evaluated for mock entries. They remain subject to market data, strategy, and risk checks.</div>
      <div style="margin-top:10px">${report.recommendations.length ? report.recommendations.map(recommendationHtml).join('') : '<p style="color:#607087">No validated execution candidate.</p>'}</div>
      ${report.watchlist.length ? `<div style="margin-top:32px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#8b96a5">Others considered · tracked for evaluation only</div><div style="margin-top:3px;font-size:11px;color:#8b96a5">These symbols are never submitted for simulated trading from this report.</div>${report.watchlist.map((candidate, index) => consideredHtml(candidate, index + 1)).join('')}` : ''}
      <div style="margin-top:32px;font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#6e7d92">Complete structured research record</div>
      <div style="margin-top:9px;padding:14px;background:#f8fafc;border:1px solid #e2e7ed;color:#536174;font-family:Menlo,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(report.fullRecord)}</div>
    </section>
    <footer style="padding:20px 40px;background:#f4f6f9;color:#718096;font-size:12px;line-height:1.55"><div><b>Brain:</b> ${report.brain ? `${escapeHtml(report.brain[1] ?? 'unavailable')} · <b>Model:</b> ${escapeHtml(report.brain[2] ?? 'unavailable')}` : 'Unavailable'}</div><div><b>Prompt version:</b> ${escapeHtml(report.promptVersion)}</div>${report.usage ? `<div style="margin-top:5px"><b>Usage:</b> ${escapeHtml(report.usage)}</div>` : ''}<div style="margin-top:10px">Simulation only. This report is not investment advice and does not establish profitability.</div></footer>
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
    currentPortfolio = portfolio(state, reportedAt),
    openPositions = Object.keys(state.positions).sort().join(', ') || 'None';
  for (const item of state.outbox.filter((x) => !x.sentAt && x.attempts < 5)) {
    try {
      await service.sendDailyResearchReport({
        ...item,
        text: `Current simulated portfolio value: USD ${currentPortfolio.equity}\nCash: USD ${currentPortfolio.cash}\nOpen positions: ${openPositions}\nAs of: ${reportedAt}\n\n${item.text}`,
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

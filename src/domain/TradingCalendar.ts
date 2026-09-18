import moment from 'moment-timezone';
import type { Session } from './models.js';
export interface TradingCalendar {
  session(date: string): Session | null;
  date(at: string): string;
  cutoff(date: string): string;
}
// Published NYSE calendars. Fail closed outside reviewed coverage; refresh yearly.
const holidays = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
]);
const early = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
export class UsTradingCalendar implements TradingCalendar {
  constructor(
    private hour = 6,
    private minute = 15,
  ) {}
  date(at: string): string {
    return moment(at).tz('America/New_York').format('YYYY-MM-DD');
  }
  cutoff(date: string): string {
    return moment
      .tz(
        `${date} ${String(this.hour).padStart(2, '0')}:${String(this.minute).padStart(2, '0')}`,
        'YYYY-MM-DD HH:mm',
        'America/Vancouver',
      )
      .toISOString();
  }
  session(date: string): Session | null {
    const day = moment.tz(date, 'YYYY-MM-DD', true, 'America/New_York');
    if (!day.isValid() || !['2026', '2027'].includes(date.slice(0, 4)))
      throw new Error('Calendar outside reviewed 2026–2027 coverage');
    if ([0, 6].includes(day.day()) || holidays.has(date)) return null;
    const at = (hm: string) =>
      moment.tz(`${date} ${hm}`, 'YYYY-MM-DD HH:mm', 'America/New_York').toISOString();
    const close = at(early.has(date) ? '13:00' : '16:00');
    return {
      date,
      open: at('09:30'),
      close,
      entryDeadline: at('11:00'),
      exitAt: new Date(Date.parse(close) - 300000).toISOString(),
      cutoffAt: this.cutoff(date),
    };
  }
}
export function assertTimezoneData(): void {
  const offset = moment.tz('2026-12-01 06:15', 'America/Vancouver').utcOffset();
  if (offset !== -420)
    throw new Error('Timezone database must include permanent UTC−7 Vancouver in 2026');
}

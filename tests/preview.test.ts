import { describe, expect, it, vi } from 'vitest';
import { previewSession, researchPreview, previewEmailText } from '../src/jobs/ResearchPreview.js';
import { UsTradingCalendar } from '../src/domain/TradingCalendar.js';
import { MockClock } from '../src/domain/Clock.js';
import { MockTradingBrain } from '../src/brain/MockTradingBrain.js';
import { samplePlan } from '../src/demo.js';

describe('preview date guardrails', () => {
  const calendar = new UsTradingCalendar();
  it.each([
    ['2026-09-18T07:57:00.000Z', '2026-09-18'],
    ['2026-09-18T13:29:59.000Z', '2026-09-18'],
    ['2026-09-18T13:30:00.000Z', '2026-09-21'],
    ['2026-09-18T21:00:00.000Z', '2026-09-21'],
    ['2026-09-19T12:00:00.000Z', '2026-09-21'],
    ['2026-09-07T12:00:00.000Z', '2026-09-08'],
    ['2026-09-18T04:30:00.000Z', '2026-09-18'],
    ['2026-12-01T14:29:59.000Z', '2026-12-01'],
  ])('selects next unopened session at %s', (at, date) => {
    expect(previewSession(calendar, at).date).toBe(date);
  });
  it('rejects skipping today before calling the brain', async () => {
    const future = previewSession(calendar, '2026-09-19T12:00:00.000Z');
    const brain = new MockTradingBrain(samplePlan(future));
    const generate = vi.spyOn(brain, 'generateTradingPlan');
    await expect(researchPreview(brain, { eligible: async () => true },
      new MockClock(new Date('2026-09-18T07:57:00.000Z')), future, '5000'))
      .rejects.toThrow('next unopened trading session');
    expect(generate).not.toHaveBeenCalled();
  });
  it('rejects a brain response for the wrong date and an inconsistent email date', async () => {
    const at = '2026-09-18T07:57:00.000Z';
    const session = previewSession(calendar, at);
    const plan = samplePlan(session);
    plan.tradingDate = '2026-09-21';
    const brain = new MockTradingBrain(plan);
    const raw = await brain.generateTradingPlan({session, startingEquity:'5000'});
    expect(() => previewEmailText(raw, session.date)).toThrow('Email and plan date mismatch');
    const run = await researchPreview(brain, { eligible: async () => true },
      new MockClock(new Date(at)), session, '5000');
    expect(run.validationStatus).toBe('invalid');
    expect(run.validationErrors).toContain('Plan date/cutoff mismatch');
  });
});

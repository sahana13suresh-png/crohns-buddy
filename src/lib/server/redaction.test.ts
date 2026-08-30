import { describe, it, expect } from 'vitest';
import { redactOutboundPayload, redactString, isSensitiveKey, REDACTED } from './redaction';
import type { MealPlanRecord } from '../types';

const RECORD: MealPlanRecord = {
  userId: 'uid-1',
  mealPlanId: '01JBQ8Z2K9AB0CDEFGH1JKMNPQ',
  title: 'MARKER-title',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  content: {
    meals: [{ mealName: 'MARKER-meal', items: [{ name: 'MARKER-item', portion: '1 cup', notes: 'MARKER-notes' }] }],
    summary: 'MARKER-summary',
    warnings: ['MARKER-warning'],
  },
};

describe('isSensitiveKey', () => {
  it('recognizes content, quiz, identity, and credential keys in any casing or separator style', () => {
    for (const key of ['content', 'Title', 'summary', 'quizAnswers', 'section3_foodTolerance',
                       'email', 'display_name', 'firebaseIdToken', 'Authorization']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('leaves diagnostic keys alone', () => {
    for (const key of ['mealPlanId', 'op', 'outcome', 'atMs', 'status', 'durationMs']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactString', () => {
  it('removes email addresses, bearer credentials, and JWT-shaped tokens', () => {
    expect(redactString('contact patient@example.co.uk now')).toBe(`contact ${REDACTED} now`);
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.c2lnbmF0dXJlZA')).toBe(`token ${REDACTED}`);
  });

  it('leaves an ordinary message unchanged', () => {
    expect(redactString('store unavailable after 3 attempts')).toBe('store unavailable after 3 attempts');
  });
});

describe('redactOutboundPayload', () => {
  it('strips every marker from a record while keeping diagnostic fields', () => {
    const redacted = redactOutboundPayload({ event: 'save_failed', mealPlanId: RECORD.mealPlanId, record: RECORD });

    expect(JSON.stringify(redacted)).not.toMatch(/MARKER/);
    expect(redacted).toMatchObject({ event: 'save_failed', mealPlanId: RECORD.mealPlanId, record: REDACTED });
  });

  it('strips markers nested under innocuous keys', () => {
    const redacted = redactOutboundPayload({ extra: { deep: [{ mealPlans: [RECORD] }] } });
    expect(JSON.stringify(redacted)).not.toMatch(/MARKER/);
  });

  it('removes an Auth_Token and an email address held at the top level', () => {
    expect(redactOutboundPayload('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.c2lnbmF0dXJlZA'))
      .toBe(`Bearer ${REDACTED}`);
    expect(redactOutboundPayload('patient@example.com')).toBe(REDACTED);
  });

  it('survives a self-referential payload', () => {
    const payload: Record<string, unknown> = { event: 'x' };
    payload.self = payload;
    expect(() => redactOutboundPayload(payload)).not.toThrow();
  });
});

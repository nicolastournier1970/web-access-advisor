import { describe, expect, it } from 'vitest';
import { recordingV2Schema } from '@waa/shared';
import { buildSingleNavigateRecording } from './analyze.js';

describe('buildSingleNavigateRecording', () => {
  it('produces a schema-valid v2 recording with exactly one navigate action', () => {
    const now = new Date('2026-07-09T12:00:00.000Z');
    const recording = buildSingleNavigateRecording('https://a.test/page', 'session_cli_1', now);

    // Must round-trip through the real contract — saveRecording refuses otherwise.
    const parsed = recordingV2Schema.parse(recording);
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.sessionId).toBe('session_cli_1');
    expect(parsed.url).toBe('https://a.test/page');
    expect(parsed.startTime).toBe('2026-07-09T12:00:00.000Z');
    expect(parsed.actions).toEqual([
      {
        type: 'navigate',
        step: 1,
        timestamp: '2026-07-09T12:00:00.000Z',
        url: 'https://a.test/page',
        redacted: false,
      },
    ]);
    expect(parsed.authCheckpoints).toEqual([]);
  });
});

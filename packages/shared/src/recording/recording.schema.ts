/**
 * Recording file format (snapshots/<sessionId>/recording.json).
 *
 * Two formats exist on disk:
 *  - v1: written by the legacy recorder. No `formatVersion` field, single crude
 *    CSS `selector` per action, credential values recorded in plaintext,
 *    no auth checkpoints. Never rewritten; upgraded in memory by
 *    `@waa/core` `loadRecording()`.
 *  - v2: written by the rewrite. Discriminated by `formatVersion: 2`; actions
 *    carry ranked locator candidates, sensitive values are redacted at the
 *    source, and login segments are represented as `authCheckpoints` instead
 *    of recorded actions. See docs/adr/0005.
 */
import { z } from 'zod';

export const browserTypeSchema = z.enum(['chromium', 'firefox', 'webkit']);
export type BrowserType = z.infer<typeof browserTypeSchema>;

export const actionTypeSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'select',
  'scroll',
  'hover',
  'key',
]);
export type ActionType = z.infer<typeof actionTypeSchema>;

/** Placeholder stored instead of a sensitive input's value. */
export const REDACTED_VALUE = '[REDACTED]';

/**
 * One locator strategy for an interacted element, in replay-preference order.
 * The replayer tries candidates in order with short per-candidate timeouts.
 */
export const targetCandidateSchema = z.discriminatedUnion('strategy', [
  // data-testid / data-test / data-qa
  z.object({ strategy: z.literal('testid'), attribute: z.string(), value: z.string() }),
  // #id — only recorded when the id does not look auto-generated
  z.object({ strategy: z.literal('id'), value: z.string() }),
  // ARIA role + accessible name — replayed via page.getByRole(role, { name })
  z.object({
    strategy: z.literal('role'),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().optional(),
  }),
  // Exact visible text — replayed via page.getByText (links/buttons)
  z.object({ strategy: z.literal('text'), value: z.string(), tag: z.string().optional() }),
  // Stable CSS selector (utility/hashed classes rejected at generation time)
  z.object({ strategy: z.literal('css'), value: z.string() }),
  // Structural nth-child path — last resort, mirrors the v1 selector behaviour
  z.object({ strategy: z.literal('nth-path'), value: z.string() }),
]);
export type TargetCandidate = z.infer<typeof targetCandidateSchema>;

export const actionTargetSchema = z.object({
  candidates: z.array(targetCandidateSchema).min(1),
  /** Human-readable description, e.g. "Item 1 breadcrumb link". */
  description: z.string().optional(),
});
export type ActionTarget = z.infer<typeof actionTargetSchema>;

/** v2 action. `selector` is kept as a legacy mirror of the best CSS candidate. */
export const actionV2Schema = z.object({
  type: actionTypeSchema,
  step: z.number().int().positive(),
  timestamp: z.string(),
  url: z.string().optional(),
  target: actionTargetSchema.optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  /** True when the recorded value was masked (password/OTP/sensitive input). */
  redacted: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ActionV2 = z.infer<typeof actionV2Schema>;

export const authCheckpointReasonSchema = z.enum(['user-marked', 'auto-detected']);

/**
 * A login segment. Actions performed during the segment are NOT recorded —
 * only this marker persists, and storageState.json is saved when the segment
 * ends. Replay pauses here when no validated storage state covers the target
 * origin (pause-for-login).
 */
export const authCheckpointSchema = z.object({
  id: z.string(),
  /** The checkpoint sits after this recorded step (0 = before the first action). */
  afterStep: z.number().int().min(0),
  reason: authCheckpointReasonSchema,
  loginUrl: z.string().optional(),
  postLoginUrl: z.string().optional(),
  storageStateSaved: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});
export type AuthCheckpoint = z.infer<typeof authCheckpointSchema>;

export const recordingV2Schema = z.object({
  formatVersion: z.literal(2),
  sessionId: z.string(),
  sessionName: z.string().optional(),
  url: z.string(),
  startTime: z.string(),
  endTime: z.string().optional(),
  duration: z.number().optional(),
  actionCount: z.number().int().min(0).optional(),
  actions: z.array(actionV2Schema),
  authCheckpoints: z.array(authCheckpointSchema).default([]),
  browserType: browserTypeSchema.optional(),
  browserName: z.string().optional(),
  useProfile: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RecordingV2 = z.infer<typeof recordingV2Schema>;

/** Legacy v1 action, exactly as found on disk. */
export const actionV1Schema = z.object({
  type: actionTypeSchema,
  step: z.number().int().positive(),
  timestamp: z.string(),
  selector: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ActionV1 = z.infer<typeof actionV1Schema>;

/**
 * Legacy v1 recording file. Distinguished from v2 by the ABSENCE of
 * `formatVersion` (v1 files carry a meaningless `metadata.version: "2.0.0"`
 * string — do not confuse the two).
 */
export const recordingV1Schema = z
  .object({
    /** Forbidden in v1: presence of formatVersion means the file is v2. */
    formatVersion: z.never().optional(),
    sessionId: z.string(),
    sessionName: z.string().optional(),
    url: z.string(),
    startTime: z.string(),
    endTime: z.string().optional(),
    duration: z.number().optional(),
    actionCount: z.number().int().min(0).optional(),
    actions: z.array(actionV1Schema),
    browserType: z.string().optional(),
    browserName: z.string().optional(),
    useProfile: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
export type RecordingV1 = z.infer<typeof recordingV1Schema>;

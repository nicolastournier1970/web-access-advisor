/**
 * Session manifest (snapshots/<sessionId>/manifest.json), written by the
 * analyzer after replay. The schema is deliberately lenient (most fields
 * optional, unknown keys tolerated) because legacy manifests on disk predate
 * this schema and must remain loadable for the session index.
 */
import { z } from 'zod';

export const domChangeTypeSchema = z.enum([
  'navigation',
  'content',
  'interaction',
  'layout',
  'none',
]);
export type DomChangeType = z.infer<typeof domChangeTypeSchema>;

export const flowTypeSchema = z.enum(['main_app', 'auth_flow', 'error_flow', 'external_redirect']);
export type FlowType = z.infer<typeof flowTypeSchema>;

export const domChangeSummarySchema = z
  .object({
    elementsAdded: z.number().default(0),
    elementsRemoved: z.number().default(0),
    ariaChanges: z.array(z.string()).default([]),
    focusChanges: z.string().optional(),
    liveRegionUpdates: z.array(z.string()).default([]),
    significantChange: z.boolean().default(false),
  })
  .catchall(z.unknown());

export const accessibilityContextSchema = z
  .object({
    focusedElement: z.string().optional(),
    screenReaderAnnouncements: z.array(z.string()).default([]),
    keyboardNavigationState: z.string().default('default'),
    modalState: z.enum(['none', 'open', 'closing']).default('none'),
    dynamicContentUpdates: z.boolean().default(false),
    ariaLiveRegions: z.array(z.string()).default([]),
  })
  .catchall(z.unknown());

/** Outcome of executing one recorded action during replay (new in v2). */
export const actionOutcomeSchema = z.enum(['executed', 'skipped', 'failed']);
export type ActionOutcome = z.infer<typeof actionOutcomeSchema>;

/**
 * Per-action replay outcome (new in v2). Recorded for EVERY action, not just
 * the ones that produced snapshots — stepDetails only cover snapshot steps, so
 * without this list failed/skipped actions were invisible in the manifest.
 */
export const actionOutcomeRecordSchema = z
  .object({
    step: z.number().int(),
    type: z.string(),
    outcome: actionOutcomeSchema,
    detail: z.string().optional(),
    /** Locator strategy that resolved the target (e.g. 'role', 'css'). */
    resolvedBy: z.string().optional(),
  })
  .catchall(z.unknown());
export type ActionOutcomeRecord = z.infer<typeof actionOutcomeRecordSchema>;

export const stepDetailSchema = z
  .object({
    step: z.number().int(),
    parentStep: z.number().int().nullable().default(null),
    action: z.string(),
    actionType: z.enum(['navigation', 'interaction', 'form_input', 'other']).default('other'),
    interactionTarget: z.string().optional(),
    flowContext: z
      .enum(['main_flow', 'modal_flow', 'form_flow', 'navigation_flow', 'sub_flow'])
      .default('main_flow'),
    uiState: z.string().default('default'),
    timestamp: z.string(),
    htmlFile: z.string(),
    axeFile: z.string(),
    axeResultsFile: z.string(),
    screenshotFile: z.string().optional(),
    url: z.string(),
    domChangeType: domChangeTypeSchema.default('none'),
    domChanges: z.string().default(''),
    tokenEstimate: z.number().default(0),
    previousStep: z.number().int().optional(),
    nextStep: z.number().int().optional(),
    isAuthRelated: z.boolean().default(false),
    excludeFromAnalysis: z.boolean().default(false),
    skipReason: z.string().optional(),
    flowType: flowTypeSchema.default('main_app'),
    /** New in v2 manifests: what actually happened when this step was replayed. */
    actionOutcome: actionOutcomeSchema.optional(),
    actionOutcomeDetail: z.string().optional(),
    domChangeSummary: domChangeSummarySchema.optional(),
    accessibilityContext: accessibilityContextSchema.optional(),
  })
  .catchall(z.unknown());
export type StepDetail = z.infer<typeof stepDetailSchema>;

/** Legacy flow grouping written by the analyzer; shapes fixed by v1 core types. */
export const actionGroupSchema = z
  .object({
    groupId: z.string(),
    steps: z.array(z.number().int()).default([]),
    description: z.string().default(''),
    flowType: flowTypeSchema.default('main_app'),
    relevantForAnalysis: z.boolean().default(true),
    tokenEstimate: z.number().default(0),
  })
  .catchall(z.unknown());
export type ActionGroup = z.infer<typeof actionGroupSchema>;

export const flowStatisticsSchema = z
  .object({
    totalSteps: z.number().default(0),
    authSteps: z.number().default(0),
    mainAppSteps: z.number().default(0),
    errorSteps: z.number().default(0),
    significantDOMChanges: z.number().default(0),
    accessibilityEvents: z.number().default(0),
  })
  .catchall(z.unknown());
export type FlowStatistics = z.infer<typeof flowStatisticsSchema>;

export const recordingContextSchema = z
  .object({
    useProfile: z.boolean().default(false),
    browserType: z.string().optional(),
    browserName: z.string().optional(),
    authenticationState: z.enum(['logged_in', 'logged_out', 'unknown']).default('unknown'),
    recordingNote: z.string().optional(),
  })
  .catchall(z.unknown());

export const sessionManifestSchema = z
  .object({
    sessionId: z.string(),
    url: z.string(),
    timestamp: z.string(),
    totalSteps: z.number().int().min(0),
    stepDetails: z.array(stepDetailSchema).default([]),
    actionGroups: z.array(actionGroupSchema).optional(),
    flowStatistics: flowStatisticsSchema.optional(),
    /** New in v2: replay outcome for every recorded action (not just snapshot steps). */
    actionOutcomes: z.array(actionOutcomeRecordSchema).optional(),
    llmOptimizations: z
      .object({
        authStepsFiltered: z.number().default(0),
        relevantStepsForAnalysis: z.number().default(0),
        totalTokenEstimate: z.number().default(0),
      })
      .optional(),
    recordingContext: recordingContextSchema.optional(),
    /** New in v2: notes about truncated/aborted replays (e.g. auth cancelled). */
    truncated: z.boolean().optional(),
    truncationReason: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .catchall(z.unknown());
export type SessionManifest = z.infer<typeof sessionManifestSchema>;

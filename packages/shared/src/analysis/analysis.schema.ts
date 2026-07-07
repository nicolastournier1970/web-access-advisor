/**
 * Analysis result shapes: axe-core violations (plus LLM enrichment) and the
 * LLM component analysis.
 *
 * Leniency policy: data that originates from third parties (axe-core) or from
 * an LLM must never be able to poison a whole persisted analysis artefact.
 * One malformed value in one issue must degrade (`.catch()`, `.nullish()`,
 * defaults), not fail the entire `analysisResultSchema` parse.
 */
import { z } from 'zod';
import { sessionManifestSchema } from '../manifest/manifest.schema.js';

export const impactSchema = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type Impact = z.infer<typeof impactSchema>;

/** WCAG reference object — the shape the legacy enrichment writes and the UI renders. */
export const wcagRefSchema = z
  .object({
    guideline: z.string().default(''),
    level: z.string().default(''),
    title: z.string().default(''),
    url: z.string().default(''),
  })
  .catchall(z.unknown());
export type WcagRef = z.infer<typeof wcagRefSchema>;

export const axeNodeSchema = z
  .object({
    html: z.string().default(''),
    /** axe target entries are string | string[] (string[] = shadow-DOM selector chain). */
    target: z.array(z.union([z.string(), z.array(z.string())])).default([]),
    failureSummary: z.string().optional(),
  })
  .catchall(z.unknown());
export type AxeNode = z.infer<typeof axeNodeSchema>;

export const axeViolationSchema = z
  .object({
    id: z.string(),
    impact: impactSchema.nullish(),
    description: z.string().default(''),
    help: z.string().default(''),
    helpUrl: z.string().default(''),
    tags: z.array(z.string()).default([]),
    nodes: z.array(axeNodeSchema).default([]),
    // LLM enrichment + step attribution added by the analyzer
    explanation: z.string().optional(),
    recommendation: z.string().optional(),
    wcagReference: wcagRefSchema.optional(),
    step: z.number().int().optional(),
    url: z.string().optional(),
    stepOccurrences: z.array(z.number().int()).optional(),
  })
  .catchall(z.unknown());
export type AxeViolation = z.infer<typeof axeViolationSchema>;

/**
 * The on-disk shape of step_NNN/axe_results.json: the FULL axe-core output
 * object (testEngine, passes, incomplete, ...), of which we type what we read.
 */
export const axeResultsFileSchema = z
  .object({
    violations: z.array(axeViolationSchema).default([]),
    url: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .catchall(z.unknown());
export type AxeResultsFile = z.infer<typeof axeResultsFileSchema>;

export const componentIssueSchema = z
  .object({
    componentName: z.string(),
    issue: z.string(),
    explanation: z.string().default(''),
    relevantHtml: z.string().default(''),
    correctedCode: z.string().default(''),
    codeChangeSummary: z.string().default(''),
    /** LLM-origin: off-vocabulary or missing impact degrades, never fails the parse. */
    impact: impactSchema.catch('moderate'),
    wcagRule: z.string().default(''),
    wcagUrl: z.string().optional(),
    selector: z.string().optional(),
    step: z.number().int().optional(),
    url: z.string().optional(),
  })
  .catchall(z.unknown());
export type ComponentIssue = z.infer<typeof componentIssueSchema>;

/** One logged LLM exchange (prompt/response), used by the debug view. */
export const llmDebugLogSchema = z
  .object({
    type: z.enum(['component', 'flow']).catch('component'),
    prompt: z.string().default(''),
    response: z.string().default(''),
    promptSize: z.number().default(0),
    responseSize: z.number().default(0),
    htmlSize: z.number().default(0),
    axeResultsCount: z.number().default(0),
    timestamp: z.string().default(''),
  })
  .catchall(z.unknown());
export type LlmDebugLog = z.infer<typeof llmDebugLogSchema>;

/** Provider-neutral LLM analysis (was `GeminiAnalysis` in v1). */
export const llmAnalysisSchema = z
  .object({
    summary: z.string().default(''),
    components: z.array(componentIssueSchema).default([]),
    enhancedAxeViolations: z
      .array(
        z
          .object({
            id: z.string(),
            explanation: z.string().default(''),
            recommendation: z.string().default(''),
            wcag: wcagRefSchema.optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    recommendations: z.array(z.string()).default([]),
    /** LLM-origin: clamped to [0, 100]; non-numeric degrades to 0. */
    score: z
      .number()
      .transform((n) => Math.min(100, Math.max(0, n)))
      .catch(0),
    debug: llmDebugLogSchema.optional(),
  })
  .catchall(z.unknown());
export type LlmAnalysis = z.infer<typeof llmAnalysisSchema>;

export const staticSectionModeSchema = z.enum(['include', 'ignore', 'separate']);
export type StaticSectionMode = z.infer<typeof staticSectionModeSchema>;

/** Persisted to snapshots/<sessionId>/analysis.json and returned by the API. */
export const analysisResultSchema = z
  .object({
    success: z.boolean(),
    sessionId: z.string(),
    snapshotCount: z.number().int().min(0).default(0),
    manifest: sessionManifestSchema,
    analysis: llmAnalysisSchema.optional(),
    axeResults: z.array(axeViolationSchema).default([]),
    warnings: z.array(z.string()).default([]),
    error: z.string().optional(),
    completedAt: z.string().optional(),
    llmProvider: z.string().optional(),
    debug: z
      .object({ llmLogs: z.array(llmDebugLogSchema).default([]) })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

/**
 * Progress phase vocabulary — carried over verbatim from the v1 engine's
 * onProgress callback so the three-phase UI mapping stays stable.
 */
export const analysisPhaseSchema = z.enum([
  'replaying-actions',
  'capturing-snapshots',
  'running-accessibility-checks',
  'processing-with-ai',
  'generating-report',
  'completed',
]);
export type AnalysisPhase = z.infer<typeof analysisPhaseSchema>;

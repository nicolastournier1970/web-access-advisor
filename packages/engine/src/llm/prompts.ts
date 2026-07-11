/**
 * Provider-neutral prompt builders. Ports the essence of the legacy Gemini
 * component-analysis prompt (packages/core/src/gemini.ts) onto the batched
 * LlmBatchRequest shape: role framing, the JSON contract mirroring
 * llmAnalysisSchema (components + mandatory enhancedAxeViolations enrichment),
 * component-naming rules, verbatim relevantHtml / code-not-prose correctedCode
 * requirements, before/after DOM awareness, WCAG URL guidance, static-section
 * handling and progressive-summary context.
 */
import type { LlmAnalysis } from '@waa/shared';
import type { LlmBatchRequest } from '../engine-types.js';

/** Cap on the batch-summary excerpt embedded in the consolidation note. */
const CONSOLIDATION_SUMMARY_CHARS = 1500;

const ROLE_FRAMING = `You are an expert screen-reader accessibility auditor. Analyze the provided DOM snapshots and axe-core reports with a primary focus on screen reader (ARIA) accessibility and assistive technology compatibility (JAWS, NVDA, VoiceOver, TalkBack, Narrator). Identify code deficiencies that hinder screen reader support and recommend precise, actionable fixes.

**ANALYSIS METHODOLOGY:**
You are analyzing HTML markup and axe-core results only. You do NOT have access to live screen reader testing or user behavior. Base every conclusion ENTIRELY on code structure, semantic markup, ARIA implementation, and static accessibility patterns evident in the snapshots and axe summaries. Report ONLY components with identified issues; do not speculate about functionality not evident in the markup.

**LEVERAGE SEMANTIC ANALYSIS BEYOND RULE-CHECKING:**
- Contextual intent: recognize developer intent behind invalid values (e.g. aria-current="yes" means current-page indication).
- Cross-reference validation: verify aria-labelledby/aria-describedby/aria-controls point at existing, visible elements; check logical consistency (aria-valuenow within aria-valuemin/aria-valuemax).
- Semantic contradictions: HTML semantics vs ARIA role conflicts, interactive-looking elements without programmatic accessibility, redundant roles (button with role="button").
- Pattern completeness: incomplete widget patterns (progressbar/combobox/tabs missing required states), multiple aria-selected="true" in single-select contexts.
- Anti-patterns: focus sabotage (onfocus="blur()"), fake links (href="javascript:void(0)"), keyboard traps, inappropriate aria-hidden on interactive content.`;

const NAMING_RULES = `**COMPONENT NAME REQUIREMENT (componentName becomes the issue title in the UI):**
Use axe-core violation title format. NEVER use "Ensure..." phrasing.
- FORBIDDEN: "Ensure an element's...", "Ensure every...", "Ensure all...", "Ensure that...", "Ensure the..."
- REQUIRED PATTERN: [Element/Component Type] + [must/should/must not] + [specific requirement]
- Examples: "Elements must only use supported ARIA attributes", "Form elements must have labels", "ARIA attributes must conform to valid values", "Elements must meet minimum color contrast ratio thresholds", "Heading levels should only increase by one", "<html> element must have a lang attribute", "All page content should be contained by landmarks".
Keep names short and specific (3-7 words where possible), reuse axe-core rule terminology, and never use generic titles like "Accessibility issue".`;

const WCAG_URL_GUIDANCE = `**WCAG REFERENCES:**
- wcagRule: WCAG 2.1 guideline reference such as "4.1.2 Name, Role, Value" (no "WCAG" prefix).
- wcagUrl: complete Understanding URL in the form https://www.w3.org/WAI/WCAG21/Understanding/[page-name].html
  Examples: 4.1.2 -> https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html; 1.4.3 -> https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html; 2.4.7 -> https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html; 2.1.1 -> https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html; 1.1.1 -> https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html
- If unsure of the exact URL, use: https://www.w3.org/WAI/WCAG21/Understanding/`;

const JSON_CONTRACT = `{
  "summary": "Brief overview of the accessibility status across the analyzed snapshots",
  "components": [
    {
      "componentName": "Axe-style violation title following the naming rules above",
      "issue": "Clear description of the issue - wrap HTML element names in backticks (e.g. \`main\`, \`h1\`, \`button\`)",
      "explanation": "Why this is a problem for screen reader users - wrap HTML element names in backticks",
      "relevantHtml": "EXACT HTML copied verbatim from the DOM snapshot - ONLY the specific problematic element(s), never <html>, <body> or unrelated parent containers",
      "correctedCode": "Complete corrected HTML markup for the exact same element(s) shown in relevantHtml - actual code, never a prose description",
      "codeChangeSummary": "Brief summary of the fix (e.g. 'Added aria-label to button', 'Changed div to semantic heading')",
      "impact": "critical|serious|moderate|minor",
      "wcagRule": "e.g. 4.1.2 Name, Role, Value",
      "wcagUrl": "https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html",
      "selector": "CSS selector uniquely identifying the problematic element (for missing elements, where it should be added)",
      "step": 1,
      "url": "URL of the snapshot the issue was found in"
    }
  ],
  "enhancedAxeViolations": [
    {
      "id": "axe rule id from the input report (e.g. landmark-one-main, label, region)",
      "explanation": "User-impact focused explanation of how this violation affects people using assistive technology",
      "recommendation": "Clear, actionable guidance on how to fix this violation - end with 'Reference: [helpUrl from the violation]'",
      "correctedCode": "Corrected HTML for the FIRST affected node of this violation (from its 'html' field) with the minimal fix applied - actual code, never a prose description",
      "codeChangeSummary": "Brief summary of the fix (e.g. 'Added aria-label to button'); note when the same pattern applies to the other affected elements",
      "wcag": {
        "guideline": "Guideline number only, no 'WCAG' prefix (WRONG: 'WCAG 2.4.6', CORRECT: '2.4.6')",
        "level": "A|AA|AAA",
        "title": "Official WCAG guideline title (e.g. Bypass Blocks)",
        "url": "https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html"
      }
    }
  ],
  "recommendations": ["actionable recommendation strings"],
  "score": 85
}`;

const OUTPUT_RULES = `**OUTPUT FORMAT - MUST FOLLOW EXACTLY:**
Respond with ONLY a valid JSON object matching this exact structure (no markdown fences, no text before or after; start with { and end with }):
${JSON_CONTRACT}

**Requirements:**
- Plain ASCII text only; no emoji or special Unicode symbols.
- ALWAYS wrap HTML element names in backticks inside issue/explanation text.
- Set "step" and "url" on every component to the snapshot the issue was observed in.
- relevantHtml must be copied EXACTLY from the DOM snapshot (verbatim, minimal offending element only). For missing-element issues, show the container where the element should be added (e.g. for a missing \`main\` landmark, the wrapper that should become/contain \`main\`; for a missing \`h1\`, the section where it belongs).
- correctedCode must be complete, working HTML for the exact same element(s) shown in relevantHtml with the minimal fix applied - never a prose description of the change.
- MANDATORY AXE ENHANCEMENT: enhance EVERY axe violation present in the input reports as one entry in "enhancedAxeViolations" (if the input lists 5 distinct violation ids, output 5 entries). Explanations must be user-impact focused, recommendations actionable and ending with 'Reference: [helpUrl]', and each entry must carry the complete wcag object (guideline number WITHOUT the 'WCAG' prefix - the UI adds it).
- AXE CORRECTED CODE: every "enhancedAxeViolations" entry must also carry "correctedCode" and "codeChangeSummary". Base correctedCode on the violation's first node's 'html' sample: reproduce that element with the minimal fix applied (complete, working HTML - never prose). When the fix is not expressible in the sampled markup alone (e.g. a color-contrast fix living in a stylesheet), show the closest code-level fix (e.g. the element with an adjusted inline style or class) and say so in codeChangeSummary.
- Deduplicate across arrays: do NOT add a "components" entry for an issue already covered by an "enhancedAxeViolations" entry; use "components" for issues your semantic analysis finds beyond the axe report.
- "score" is an overall 0-100 accessibility score for the analyzed content.
- Deduplicate: report each distinct issue once even if it appears in several snapshots (attribute it to the first step it appears in).
- Prioritize: critical (blocks task completion), serious (significantly impairs), moderate (creates barriers), minor (polish).`;

/** Per-mode instructions for recurring page chrome (header/nav/footer). */
function staticSectionInstruction(mode: LlmBatchRequest['staticSectionMode']): string {
  switch (mode) {
    case 'ignore':
      return '**STATIC SECTIONS: IGNORE.** Skip recurring page chrome entirely (site header, primary navigation, footer, cookie banners). Analyze only the main/unique content of each snapshot.';
    case 'separate':
      return '**STATIC SECTIONS: ANALYZE ONCE.** Recurring page chrome (site header, primary navigation, footer) must be analyzed a single time for the whole batch - report each chrome issue once (attributed to the first snapshot it appears in), then analyze only the main/unique content of each snapshot.';
    case 'include':
      return '**STATIC SECTIONS: INCLUDE.** Analyze all page content including recurring chrome (header, navigation, footer) in every snapshot.';
  }
}

/** Renders one snapshot section: step/url/DOM-change header, HTML, axe JSON. */
function snapshotSection(snapshot: LlmBatchRequest['snapshots'][number]): string {
  return `---
**Snapshot - step ${snapshot.step}**
- URL: ${snapshot.url}
- DOM change since previous step: ${snapshot.domChangeDescription || 'unknown'}

DOM snapshot:
${snapshot.html}

Axe-core violations (slimmed JSON):
${snapshot.axeViolationsJson}`;
}

/**
 * Builds the full component-analysis prompt for one batch. Includes the
 * progressive summary section only when the request carries one, and adapts
 * the before/after guidance to single- vs multi-snapshot batches.
 */
export function buildComponentAnalysisPrompt(request: LlmBatchRequest): string {
  const sections: string[] = [ROLE_FRAMING, staticSectionInstruction(request.staticSectionMode)];

  if (request.progressiveSummary) {
    sections.push(`**PREVIOUS BATCH CONTEXT (progressive summary):**
${request.progressiveSummary}

Build on these findings: do not re-report issues already covered above unless they persist with new evidence in this batch, and note accessibility state transitions that carry over from previous batches.`);
  }

  const multi = request.snapshots.length > 1;
  sections.push(
    multi
      ? `**BEFORE/AFTER DOM-STATE AWARENESS:**
The ${request.snapshots.length} snapshots below are sequential states of one user flow. Compare consecutive snapshots to validate dynamic behavior: ARIA state updates (aria-expanded/aria-selected/aria-checked/aria-invalid) matching actual visibility and selection changes, focus management structure across modal/dialog/dropdown transitions, and live-region announcements for content that appears or changes. Use each snapshot's "DOM change since previous step" description to target the comparison.`
      : `**SINGLE-SNAPSHOT ANALYSIS:**
Only one snapshot is provided; analyze its static structure, ensuring ARIA attributes and semantic markup are configured to support correct dynamic behavior (state attributes, live regions, focus containment).`,
  );

  sections.push(
    `**BATCH ${request.batchId}: ${request.snapshots.length} snapshot(s) to analyze**

${request.snapshots.map(snapshotSection).join('\n\n')}`,
  );

  sections.push(NAMING_RULES, WCAG_URL_GUIDANCE, OUTPUT_RULES);
  return sections.join('\n\n');
}

/**
 * Builds the human-readable summary line used when batch analyses are merged
 * locally (no LLM round-trip): a header naming the session URL and batch
 * count, followed by the concatenated batch summaries capped at ~1500 chars.
 */
export function buildConsolidationNote(batches: LlmAnalysis[], sessionUrl: string): string {
  const head = `Consolidated accessibility analysis for ${sessionUrl} across ${batches.length} batch(es).`;
  // Set-dedupe: batches of similar page states produce verbatim-identical
  // summaries; repeating them reads as noise in the report header.
  const summaries = [...new Set(batches.map((b) => b.summary.trim()).filter((s) => s.length > 0))];
  if (summaries.length === 0) return head;
  let joined = summaries.join(' ');
  if (joined.length > CONSOLIDATION_SUMMARY_CHARS) {
    joined = `${joined.slice(0, CONSOLIDATION_SUMMARY_CHARS)}...`;
  }
  return `${head} Key findings: ${joined}`;
}

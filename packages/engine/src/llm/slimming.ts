/**
 * Payload slimming for LLM prompts: axe violation trimming and byte-aware
 * HTML truncation. Ported from the legacy filterAxeResultsForAnalysis /
 * truncateHtml (packages/core/src/gemini.ts) minus env-var toggles and
 * console noise.
 */
import { Buffer } from 'node:buffer';
import type { AxeViolation } from '@waa/shared';

/** Max nodes kept per violation — the LLM only needs representative examples. */
const MAX_NODES_PER_VIOLATION = 5;
/** Max characters of a single node's HTML sample. */
const MAX_NODE_HTML_CHARS = 500;
/** Marker appended to truncated HTML so the model knows content is missing. */
const TRUNCATION_MARKER = '<!-- truncated -->';
/** How far back (chars) we search for a tag boundary before giving up. */
const TAG_BOUNDARY_WINDOW = 1000;

/**
 * Slims axe violations for prompt inclusion: drops entries with no impact or
 * no offending nodes (the equivalent of dropping passes/incomplete results),
 * keeps at most 5 nodes per violation, truncates each node's HTML sample to
 * 500 chars, and strips every property the LLM does not need. Output stays
 * assignable to AxeViolation.
 */
export function slimAxeViolations(violations: AxeViolation[]): AxeViolation[] {
  if (!Array.isArray(violations)) return [];
  return violations
    .filter((v) => v != null && typeof v.id === 'string' && v.impact != null && (v.nodes?.length ?? 0) > 0)
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description ?? '',
      help: violation.help ?? '',
      helpUrl: violation.helpUrl ?? '',
      tags: violation.tags ?? [],
      nodes: (violation.nodes ?? []).slice(0, MAX_NODES_PER_VIOLATION).map((node) => ({
        html: (node.html ?? '').slice(0, MAX_NODE_HTML_CHARS),
        target: node.target ?? [],
        ...(node.failureSummary !== undefined ? { failureSummary: node.failureSummary } : {}),
      })),
    }));
}

/**
 * Largest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, found by
 * binary search over the character index; a trailing lone high surrogate is
 * trimmed so the result never ends mid code point.
 */
function slicePrefixToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = text.slice(0, lo);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Byte-aware HTML truncation. Returns the input unchanged when it already
 * fits in `maxBytes` (UTF-8). Otherwise cuts so that the result INCLUDING the
 * appended '<!-- truncated -->' marker fits in `maxBytes`, backing off to the
 * last `<` tag boundary when one exists within the final 1000 characters (so
 * the model never sees a half-open tag). Degenerate budgets smaller than the
 * marker fall back to a plain byte slice without the marker.
 */
export function truncateHtml(html: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(html, 'utf8') <= maxBytes) return html;

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  if (maxBytes <= markerBytes) return slicePrefixToBytes(html, maxBytes);

  let slice = slicePrefixToBytes(html, maxBytes - markerBytes);
  const lastOpen = slice.lastIndexOf('<');
  if (lastOpen > 0 && slice.length - lastOpen <= TAG_BOUNDARY_WINDOW) {
    slice = slice.slice(0, lastOpen);
  }
  return slice + TRUNCATION_MARKER;
}

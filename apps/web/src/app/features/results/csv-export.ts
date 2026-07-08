/**
 * Client-side CSV export of the merged findings list (ports the legacy
 * csvExport cleaning/escaping rules onto the Phase 5 unified columns:
 * severity, component, issue, wcag, selector, step, url).
 */
import type { AnalysisResult } from '@waa/shared';
import type { Finding } from './results-view';

export const CSV_HEADER = 'severity,component,issue,wcag,selector,step,url';

/** Legacy cleaning: strip tags/entities, collapse whitespace and newlines. */
export function cleanTextForCsv(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quote fields containing commas/quotes/newlines; double internal quotes. */
export function escapeCsvField(text: string): string {
  const cleaned = cleanTextForCsv(text);
  if (cleaned.includes('"') || cleaned.includes(',') || cleaned.includes('\n')) {
    return `"${cleaned.replace(/"/g, '""')}"`;
  }
  return cleaned;
}

/** One CSV document from the merged findings (auth steps already excluded). */
export function buildCsv(findings: readonly Finding[]): string {
  const lines = findings.map((finding) =>
    [
      escapeCsvField(finding.severity.toUpperCase()),
      escapeCsvField(finding.title),
      escapeCsvField([finding.issue, finding.explanation].filter(Boolean).join(' ')),
      escapeCsvField(finding.wcagLabel),
      escapeCsvField(finding.selector || 'Not specified'),
      escapeCsvField(finding.step !== undefined ? String(finding.step) : ''),
      escapeCsvField(finding.url ?? ''),
    ].join(','),
  );
  return [CSV_HEADER, ...lines].join('\n');
}

/** accessibility-analysis-<domain>-<timestamp>.csv (legacy naming rule). */
export function csvFilename(result: AnalysisResult, now: Date = new Date()): string {
  const baseUrl = result.manifest.url || 'accessibility-analysis';
  let domain = 'unknown-site';
  try {
    domain = new URL(baseUrl).hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9-]/g, '-');
  } catch {
    domain = baseUrl.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30);
  }
  const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  return `accessibility-analysis-${domain}-${timestamp}.csv`;
}

/** Trigger a client-side download of the CSV (blob + temporary anchor). */
export function downloadCsv(csv: string, filename: string, doc: Document = document): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.visibility = 'hidden';
  doc.body.appendChild(link);
  link.click();
  doc.body.removeChild(link);
  URL.revokeObjectURL(url);
}

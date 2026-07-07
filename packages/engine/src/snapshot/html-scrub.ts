/**
 * Pure HTML scrubbing helpers applied to captured snapshots BEFORE they are
 * written to disk or sent to an LLM.
 *
 *  - {@link scrubHtmlForAnalysis}: noise reduction (scripts/styles/comments),
 *    ported from the legacy `filterHtmlForAnalysis` in
 *    packages/core/src/gemini.ts.
 *  - {@link scrubSensitiveValues}: security scrub that neutralizes user input
 *    captured into value attributes / textareas (new in v2).
 *
 * Both are regex-based, like the legacy implementation. Known limits: regexes
 * do not build a real DOM, so pathological markup (e.g. a literal
 * `</textarea>` inside a textarea's text, `>` inside attribute values, or
 * conditional comments) can be over- or under-matched. That trade-off is
 * acceptable because the output feeds analysis, not rendering, and neither
 * function ever throws on malformed input.
 */

/**
 * Strip content that adds tokens but no accessibility signal: `<script>` and
 * `<style>` blocks (including their content), `<link>` tags, most `<meta>`
 * tags (charset / viewport / og: are kept for context, matching the legacy
 * filter), HTML comments, and runs of 3+ whitespace characters (collapsed to
 * a single space).
 *
 * Never throws; returns the input unchanged if scrubbing fails.
 */
export function scrubHtmlForAnalysis(html: string): string {
  try {
    return (
      html
        // Script tags and their content.
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        // Style tags and their content.
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        // Link tags (stylesheets, icons, preloads).
        .replace(/<link\b[^>]*>/gi, '')
        // Meta tags, except charset/viewport/og: which help the LLM.
        .replace(/<meta\b(?![^>]*(?:viewport|charset|og:))[^>]*>/gi, '')
        // HTML comments.
        .replace(/<!--[\s\S]*?-->/g, '')
        // Collapse repeated whitespace.
        .replace(/\s{3,}/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
    );
  } catch {
    return html;
  }
}

/**
 * `<input type>` values that are SAFE to keep: they are part of the page's
 * own markup (form plumbing / option labels), not text the user typed.
 * Every other type — password, email, tel, number, search, text, and any
 * unknown/custom type, including a missing `type` (which defaults to text) —
 * is treated as user input and has its `value` emptied.
 */
const KEEP_VALUE_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'checkbox',
  'radio',
  'reset',
  'image',
]);

/** Matches a `value=...` attribute (double-quoted, single-quoted, or bare). */
const VALUE_ATTR_RE = /(\svalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** Matches a `data-value=...` attribute for outright removal. */
const DATA_VALUE_ATTR_RE = /\sdata-value\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

/** Extracts the `type` attribute value from an input tag's raw text. */
const TYPE_ATTR_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Neutralize user-entered data captured in a snapshot, so credentials, email
 * addresses, search queries etc. never reach disk or the LLM:
 *
 *  - `value="..."` is replaced with `value=""` on every `<input>` whose type
 *    is user-typed (password/email/tel/number/search/text, plus missing or
 *    unknown types); hidden/submit/button/checkbox/radio/reset/image inputs
 *    keep their values (those are markup, not input);
 *  - `<textarea>...</textarea>` inner text is blanked;
 *  - `data-value="..."` attributes (autocomplete widgets mirror typed text
 *    there) are stripped from ALL tags.
 *
 * Structure is preserved (`value=""` remains, tags are untouched), and the
 * function is idempotent: scrub(scrub(x)) === scrub(x). Never throws on
 * malformed input.
 */
export function scrubSensitiveValues(html: string): string {
  try {
    let out = html;

    // 1. Empty value= on user-typed <input> tags.
    out = out.replace(/<input\b[^>]*>/gi, (tag) => {
      const typeMatch = TYPE_ATTR_RE.exec(tag);
      const type = (typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? 'text').toLowerCase();
      if (KEEP_VALUE_INPUT_TYPES.has(type)) {
        return tag;
      }
      return tag.replace(VALUE_ATTR_RE, '$1""');
    });

    // 2. Blank textarea content (any typed text lives between the tags).
    out = out.replace(/(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi, '$1$2');

    // 3. Strip data-value attributes everywhere.
    out = out.replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(DATA_VALUE_ATTR_RE, ''));

    return out;
  } catch {
    return html;
  }
}

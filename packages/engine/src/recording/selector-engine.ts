/**
 * Selector engine for recording format v2 (docs/adr/0005).
 *
 * Replaces the legacy single-selector `getSelector` with a ranked list of
 * locator strategies per interacted element:
 *
 *   testid → id → role+name → text → css → nth-path
 *
 * The generation logic runs INSIDE the recorded page (injected via
 * `page.addInitScript`), so it is shipped as a self-contained JavaScript
 * source string ({@link buildInPageSelectorScript}). Whatever comes back over
 * the exposeFunction bridge is untrusted and must pass through
 * {@link sanitizeCandidates} before touching a RecordingV2.
 */
import { targetCandidateSchema, type TargetCandidate } from '@waa/shared';

/** Hard cap on candidates kept per action (in-page script emits ≤6 anyway). */
const MAX_CANDIDATES = 6;
/** Hard cap on any string field of a candidate crossing the bridge. */
const MAX_FIELD_LENGTH = 200;
/** Max chars of a name/value shown in the human description. */
const MAX_DESCRIPTION_VALUE = 60;

/**
 * Self-contained JavaScript (no imports, no TypeScript syntax) that installs
 * `window.__waaGetTargetCandidates(el)` in the recorded page. The installed
 * function returns an array of plain candidate objects in replay-preference
 * order (testid → id → role → text → css → nth-path) and NEVER throws: each
 * strategy is individually try/caught and a failing strategy is skipped.
 *
 * Intended usage: `page.addInitScript(buildInPageSelectorScript())`, then call
 * the function from the event-listener script and forward its result through
 * an exposed function into {@link sanitizeCandidates}.
 */
export function buildInPageSelectorScript(): string {
  return IN_PAGE_SCRIPT;
}

/**
 * Validate raw candidate data received from the in-page script over the
 * exposeFunction bridge. Entries that fail `targetCandidateSchema` are
 * silently dropped, at most {@link MAX_CANDIDATES} survive, and every string
 * field is truncated to {@link MAX_FIELD_LENGTH} chars so a hostile or broken
 * page cannot bloat recording.json. Non-array input yields `[]`.
 */
export function sanitizeCandidates(raw: unknown): TargetCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: TargetCandidate[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_CANDIDATES) break;
    const parsed = targetCandidateSchema.safeParse(entry);
    if (!parsed.success) continue;
    out.push(capStringFields(parsed.data));
  }
  return out;
}

/**
 * Short human-readable label for the live action feed, derived from the most
 * descriptive candidate available (role+name reads best, structural paths
 * worst): `button 'Submit'`, `#main-nav`, `a.breadcrumb-link`. Returns the
 * literal string `'element'` when no candidate survives sanitization.
 */
export function describeTarget(candidates: TargetCandidate[]): string {
  const order: Array<TargetCandidate['strategy']> = [
    'role',
    'text',
    'id',
    'testid',
    'css',
    'nth-path',
  ];
  for (const strategy of order) {
    const candidate = candidates.find((c) => c.strategy === strategy);
    if (!candidate) continue;
    switch (candidate.strategy) {
      case 'role':
        return `${candidate.role} '${clip(candidate.name)}'`;
      case 'text':
        return `${candidate.tag ?? 'element'} '${clip(candidate.value)}'`;
      case 'id':
        return `#${candidate.value}`;
      case 'testid':
        return `[${candidate.attribute}="${clip(candidate.value)}"]`;
      case 'css':
        return candidate.value;
      case 'nth-path': {
        // Full paths are noisy; the deepest segment is enough for a feed line.
        const segments = candidate.value.split(' > ');
        return segments[segments.length - 1] ?? candidate.value;
      }
    }
  }
  return 'element';
}

/** Truncate a display value so feed lines stay one-line short. */
function clip(value: string): string {
  return value.length > MAX_DESCRIPTION_VALUE
    ? `${value.slice(0, MAX_DESCRIPTION_VALUE - 1)}…`
    : value;
}

/** Return a copy of the candidate with every string field length-capped. */
function capStringFields(candidate: TargetCandidate): TargetCandidate {
  const cap = (s: string): string =>
    s.length > MAX_FIELD_LENGTH ? s.slice(0, MAX_FIELD_LENGTH) : s;
  switch (candidate.strategy) {
    case 'testid':
      return { ...candidate, attribute: cap(candidate.attribute), value: cap(candidate.value) };
    case 'id':
      return { ...candidate, value: cap(candidate.value) };
    case 'role':
      return { ...candidate, role: cap(candidate.role), name: cap(candidate.name) };
    case 'text':
      return candidate.tag === undefined
        ? { ...candidate, value: cap(candidate.value) }
        : { ...candidate, value: cap(candidate.value), tag: cap(candidate.tag) };
    case 'css':
    case 'nth-path':
      return { ...candidate, value: cap(candidate.value) };
  }
}

/*
 * The in-page source below is plain browser JavaScript kept in a String.raw
 * template so regex backslashes survive verbatim. It must not contain
 * backticks or "${" sequences.
 */
const IN_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';

  /** True when an id looks machine-generated (React useId, Radix, Ember, hashes). */
  function isAutoGeneratedId(id) {
    if (!/[a-zA-Z]/.test(id)) return true;
    if (id.charAt(0) === ':') return true;
    if (/^radix-/.test(id)) return true;
    if (/^ember\d/.test(id)) return true;
    if (/\d{3,}/.test(id)) return true;
    return false;
  }

  /** True for utility/hashed CSS classes (tailwind, styled-components, emotion). */
  function isUtilityClass(cls) {
    if (cls.length > 40) return true;
    if (cls.indexOf(':') !== -1) return true;
    if (cls.indexOf('[') !== -1) return true;
    if (cls.indexOf(']') !== -1) return true;
    if (cls.indexOf('/') !== -1) return true;
    if (cls.indexOf('!') !== -1) return true;
    if (/^css-/.test(cls)) return true;
    if (/^sc-/.test(cls)) return true;
    if (/\d{4,}/.test(cls)) return true;
    return false;
  }

  function stableClasses(el) {
    var out = [];
    if (!el.classList) return out;
    for (var i = 0; i < el.classList.length; i++) {
      var cls = el.classList[i];
      if (!isUtilityClass(cls)) out.push(cls);
    }
    return out;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return value;
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function trimmedText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Implicit ARIA role for common interactive tags; null when unknown. */
  function implicitRole(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'text' || type === 'email' || type === 'password' || type === 'search') {
        return 'textbox';
      }
      return null;
    }
    return null;
  }

  /** Accessible-name approximation: aria-label > aria-labelledby > label[for] > text > alt > title. */
  function accessibleName(el, role) {
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    var labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      var ids = labelledby.split(/\s+/);
      var parts = [];
      for (var i = 0; i < ids.length; i++) {
        if (!ids[i]) continue;
        var ref = document.getElementById(ids[i]);
        if (ref) {
          var refText = trimmedText(ref);
          if (refText) parts.push(refText);
        }
      }
      if (parts.length > 0) return parts.join(' ');
    }

    if (el.id) {
      var label = null;
      try {
        label = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      } catch (e) {
        label = null;
      }
      if (label) {
        var labelText = trimmedText(label);
        if (labelText) return labelText;
      }
    }

    if (role === 'button' || role === 'link') {
      var text = trimmedText(el);
      if (text && text.length <= 80) return text;
    }

    if (el.tagName.toLowerCase() === 'img') {
      var alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
    }

    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    return '';
  }

  /** Shortest unique tag+class selector, optionally anchored on the parent. */
  function cssCandidate(el) {
    var tag = el.tagName.toLowerCase();
    var classes = stableClasses(el);
    if (classes.length === 0) return null;

    var attempts = [];
    var selector = tag;
    for (var i = 0; i < classes.length && i < 3; i++) {
      selector += '.' + cssEscape(classes[i]);
      attempts.push(selector);
    }
    for (var j = 0; j < attempts.length; j++) {
      if (isUnique(attempts[j])) return attempts[j];
    }

    var parent = el.parentElement;
    if (parent && parent.tagName) {
      var parentClasses = stableClasses(parent);
      var parentSelector = parent.tagName.toLowerCase();
      if (parentClasses.length > 0) parentSelector += '.' + cssEscape(parentClasses[0]);
      for (var k = 0; k < attempts.length; k++) {
        var combined = parentSelector + ' > ' + attempts[k];
        if (isUnique(combined)) return combined;
      }
    }
    return null;
  }

  /** Structural tag:nth-child path up from the element (nearest 12 segments, body excluded). */
  function nthPath(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1 && segments.length < 12) {
      var tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      var parent = node.parentElement;
      if (!parent) {
        segments.unshift(tag);
        break;
      }
      var index = 1;
      var sibling = node;
      while ((sibling = sibling.previousElementSibling) !== null) index++;
      segments.unshift(tag + ':nth-child(' + index + ')');
      node = parent;
    }
    if (segments.length === 0) return el.tagName ? el.tagName.toLowerCase() : '';
    return segments.join(' > ');
  }

  window.__waaGetTargetCandidates = function (el) {
    var candidates = [];
    try {
      if (el && el.nodeType === 3) el = el.parentElement;
      if (!el || el.nodeType !== 1 || !el.tagName) return candidates;

      // 1. testid: first present of data-testid / data-test / data-qa.
      try {
        var testAttrs = ['data-testid', 'data-test', 'data-qa'];
        for (var i = 0; i < testAttrs.length; i++) {
          var attrValue = el.getAttribute(testAttrs[i]);
          if (attrValue !== null && attrValue !== '') {
            candidates.push({ strategy: 'testid', attribute: testAttrs[i], value: attrValue });
            break;
          }
        }
      } catch (e1) {}

      // 2. id: only when it does not look auto-generated.
      try {
        if (el.id && !isAutoGeneratedId(el.id)) {
          candidates.push({ strategy: 'id', value: el.id });
        }
      } catch (e2) {}

      // 3. role + accessible name.
      try {
        var explicitRole = el.getAttribute('role');
        var role = explicitRole && explicitRole.trim()
          ? explicitRole.trim().split(/\s+/)[0]
          : implicitRole(el);
        if (role) {
          var name = accessibleName(el, role);
          if (name) candidates.push({ strategy: 'role', role: role, name: name });
        }
      } catch (e3) {}

      // 4. exact visible text for a / button / summary.
      try {
        var tag = el.tagName.toLowerCase();
        if (tag === 'a' || tag === 'button' || tag === 'summary') {
          var text = trimmedText(el);
          if (text.length >= 1 && text.length <= 80) {
            candidates.push({ strategy: 'text', value: text, tag: tag });
          }
        }
      } catch (e4) {}

      // 5. unique stable CSS selector.
      try {
        var css = cssCandidate(el);
        if (css) candidates.push({ strategy: 'css', value: css });
      } catch (e5) {}

      // 6. nth-child path — always emitted as the last resort.
      try {
        var path = nthPath(el);
        if (path) candidates.push({ strategy: 'nth-path', value: path });
      } catch (e6) {}
    } catch (e0) {}
    return candidates;
  };
})();
`;

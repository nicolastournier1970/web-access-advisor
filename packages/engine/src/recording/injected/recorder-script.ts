/**
 * In-page event capture script for the v2 recorder.
 *
 * {@link buildRecorderScript} returns self-contained browser JavaScript (no
 * imports, no TypeScript syntax) intended for `page.addInitScript`. It bundles
 * the selector-engine source (which installs `window.__waaGetTargetCandidates`)
 * and registers capture-phase listeners that forward user interactions over
 * two exposed-function bridges:
 *
 *   window.__waaRecord(payload)      — click / fill / select / key events
 *   window.__waaAuthSuspect(payload) — password-field focus (login suspicion)
 *
 * CREDENTIAL RULE: the value of a sensitive input (type=password, credential
 * autocomplete tokens, or a name/id matching /passw|pwd|otp|secret|token|cvv|pin/i)
 * is replaced with the literal '[REDACTED]' (with `redacted: true`) BEFORE the
 * payload crosses the bridge — the real value never leaves the page. Every
 * handler is try/catch-silent and both bridges are existence-guarded, so a
 * page can never break (or detect) recording via thrown errors.
 */
import { buildInPageSelectorScript } from '../selector-engine.js';

/**
 * Full init-script source: selector engine first (installs
 * `__waaGetTargetCandidates`), then the listener installer below. Idempotent —
 * a second evaluation in the same document is a no-op.
 */
export function buildRecorderScript(): string {
  return `${buildInPageSelectorScript()}\n${LISTENERS_SCRIPT}`;
}

/*
 * Plain browser JavaScript in a String.raw template so regex backslashes
 * survive verbatim. It must not contain backticks or "${" sequences.
 */
const LISTENERS_SCRIPT = String.raw`
(function () {
  'use strict';
  if (window.__waaRecorderListenersInstalled) return;
  window.__waaRecorderListenersInstalled = true;

  var REDACTED = '[REDACTED]';
  var MAX_TEXT = 80;

  function send(payload) {
    try {
      if (typeof window.__waaRecord === 'function') window.__waaRecord(payload);
    } catch (e) {}
  }

  function sendAuthSuspect(payload) {
    try {
      if (typeof window.__waaAuthSuspect === 'function') window.__waaAuthSuspect(payload);
    } catch (e) {}
  }

  function candidatesFor(el) {
    try {
      if (typeof window.__waaGetTargetCandidates === 'function') {
        return window.__waaGetTargetCandidates(el) || [];
      }
    } catch (e) {}
    return [];
  }

  /** Element for an event target (text nodes resolve to their parent). */
  function resolveElement(target) {
    var el = target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || el.nodeType !== 1 || !el.tagName) return null;
    return el;
  }

  function attr(el, name) {
    try {
      return el.getAttribute(name) || '';
    } catch (e) {
      return '';
    }
  }

  /** True when the field's value must never cross the bridge. */
  function isSensitiveField(el) {
    try {
      if (attr(el, 'type').toLowerCase() === 'password') return true;
      var auto = attr(el, 'autocomplete').toLowerCase();
      if (auto.indexOf('current-password') !== -1) return true;
      if (auto.indexOf('new-password') !== -1) return true;
      if (auto.indexOf('one-time-code') !== -1) return true;
      var nameAndId = attr(el, 'name') + ' ' + (el.id || '');
      if (/passw|pwd|otp|secret|token|cvv|pin/i.test(nameAndId)) return true;
    } catch (e) {}
    return false;
  }

  function shortText(el) {
    var text = '';
    try {
      text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  }

  /** Base payload: kind + candidates + tag/type/text metadata (no empties). */
  function basePayload(kind, el) {
    var payload = { kind: kind, candidates: candidatesFor(el) };
    try {
      if (el.tagName) payload.tag = el.tagName.toLowerCase();
      var type = attr(el, 'type');
      if (type) payload.inputType = type;
      var text = shortText(el);
      if (text) payload.text = text;
    } catch (e) {}
    return payload;
  }

  document.addEventListener('click', function (event) {
    try {
      var el = resolveElement(event.target);
      if (!el) return;
      send(basePayload('click', el));
    } catch (e) {}
  }, true);

  document.addEventListener('blur', function (event) {
    try {
      var el = resolveElement(event.target);
      if (!el) return;
      var tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
      var sensitive = isSensitiveField(el);
      var value = '';
      if (!sensitive) {
        try {
          value = el.value == null ? '' : String(el.value);
        } catch (e2) {}
      }
      var payload = basePayload('fill', el);
      payload.value = sensitive ? REDACTED : value;
      payload.redacted = sensitive ? true : false;
      send(payload);
    } catch (e) {}
  }, true);

  document.addEventListener('change', function (event) {
    try {
      var el = resolveElement(event.target);
      if (!el || el.tagName !== 'SELECT') return;
      var payload = basePayload('select', el);
      try {
        payload.value = el.value == null ? '' : String(el.value);
      } catch (e2) {
        payload.value = '';
      }
      payload.redacted = false;
      send(payload);
    } catch (e) {}
  }, true);

  var IMPORTANT_KEYS = [
    'Tab', 'Enter', ' ', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown'
  ];

  document.addEventListener('keydown', function (event) {
    try {
      if (IMPORTANT_KEYS.indexOf(event.key) === -1) return;
      var el = resolveElement(document.activeElement || document.body);
      var keyValue = event.key === ' ' ? 'Space' : event.key;
      if (event.shiftKey && event.key === 'Tab') keyValue = 'Shift+Tab';
      var payload = el ? basePayload('key', el) : { kind: 'key', candidates: [] };
      payload.value = keyValue;
      payload.redacted = false;
      send(payload);
    } catch (e) {}
  }, true);

  document.addEventListener('focusin', function (event) {
    try {
      var el = resolveElement(event.target);
      if (!el || el.tagName !== 'INPUT') return;
      if (attr(el, 'type').toLowerCase() !== 'password') return;
      sendAuthSuspect({ reason: 'password-field', url: String(window.location.href) });
    } catch (e) {}
  }, true);
})();
`;

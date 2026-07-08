// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDACTED_VALUE } from '@waa/shared';
import { buildInPageSelectorScript } from '../selector-engine.js';
import { buildRecorderScript } from './recorder-script.js';

const recordMock = vi.fn();
const authSuspectMock = vi.fn();

type Payload = Record<string, unknown>;

function recordedPayloads(): Payload[] {
  return recordMock.mock.calls.map((call) => call[0] as Payload);
}

function lastPayload(): Payload {
  const payloads = recordedPayloads();
  expect(payloads.length).toBeGreaterThan(0);
  return payloads[payloads.length - 1]!;
}

function dispatchBlur(el: Element): void {
  el.dispatchEvent(new FocusEvent('blur'));
}

function dispatchKey(target: Element, key: string, shiftKey = false): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

beforeAll(() => {
  (window as unknown as Record<string, unknown>)['__waaRecord'] = recordMock;
  (window as unknown as Record<string, unknown>)['__waaAuthSuspect'] = authSuspectMock;
  // Indirect eval so the script runs against the jsdom globals, exactly like
  // page.addInitScript would run it against the real page.
  (0, eval)(buildRecorderScript());
});

beforeEach(() => {
  document.body.innerHTML = '';
  recordMock.mockClear();
  authSuspectMock.mockClear();
});

describe('buildRecorderScript source string', () => {
  it('is self-contained page JavaScript (no module syntax, no template interpolation)', () => {
    const script = buildRecorderScript();
    expect(script).not.toContain('export ');
    expect(script).not.toContain('import ');
    expect(script).not.toContain('${');
  });

  it('embeds the selector-engine in-page source verbatim', () => {
    expect(buildRecorderScript()).toContain(buildInPageSelectorScript());
    expect(buildRecorderScript()).toContain('__waaGetTargetCandidates');
  });

  it('references both bridges behind existence guards and the redaction literal', () => {
    const script = buildRecorderScript();
    expect(script).toContain('window.__waaRecord');
    expect(script).toContain('window.__waaAuthSuspect');
    expect(script).toContain(`'${REDACTED_VALUE}'`);
    expect(script).toContain("typeof window.__waaRecord === 'function'");
    expect(script).toContain("typeof window.__waaAuthSuspect === 'function'");
  });

  it('is idempotent: a second evaluation does not double-register listeners', () => {
    (0, eval)(buildRecorderScript());
    document.body.innerHTML = '<button id="once">Go</button>';
    document.getElementById('once')!.click();
    expect(recordMock).toHaveBeenCalledTimes(1);
  });
});

describe('click capture', () => {
  it('sends a click payload with selector candidates and metadata', () => {
    document.body.innerHTML = '<button id="save-btn" data-testid="save">Save</button>';
    document.getElementById('save-btn')!.click();
    const payload = lastPayload();
    expect(payload['kind']).toBe('click');
    expect(payload['tag']).toBe('button');
    expect(payload['text']).toBe('Save');
    expect(payload['candidates']).toEqual(
      expect.arrayContaining([{ strategy: 'testid', attribute: 'data-testid', value: 'save' }]),
    );
  });
});

describe('fill capture on blur', () => {
  it('captures a plain text input value verbatim', () => {
    document.body.innerHTML = '<input id="fullname" type="text">';
    const input = document.getElementById('fullname') as HTMLInputElement;
    input.value = 'Alice Example';
    dispatchBlur(input);
    expect(lastPayload()).toMatchObject({
      kind: 'fill',
      tag: 'input',
      inputType: 'text',
      value: 'Alice Example',
      redacted: false,
    });
  });

  it('captures textarea values', () => {
    document.body.innerHTML = '<textarea id="notes"></textarea>';
    const area = document.getElementById('notes') as HTMLTextAreaElement;
    area.value = 'some notes';
    dispatchBlur(area);
    expect(lastPayload()).toMatchObject({ kind: 'fill', tag: 'textarea', value: 'some notes' });
  });

  it('NEVER sends a password value across the bridge', () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    const input = document.getElementById('pw') as HTMLInputElement;
    input.value = 'hunter2-super-secret';
    dispatchBlur(input);
    expect(lastPayload()).toMatchObject({ kind: 'fill', value: REDACTED_VALUE, redacted: true });
    expect(JSON.stringify(recordMock.mock.calls)).not.toContain('hunter2-super-secret');
  });

  it.each([
    ['autocomplete current-password', '<input id="f" type="text" autocomplete="current-password">'],
    ['autocomplete new-password', '<input id="f" type="text" autocomplete="new-password">'],
    ['autocomplete one-time-code', '<input id="f" type="text" autocomplete="one-time-code">'],
    ['name contains passw', '<input id="f" type="text" name="user_password_field">'],
    ['name contains pwd', '<input id="f" type="text" name="pwd">'],
    ['id contains otp', '<input id="otp-entry" type="text">'],
    ['name contains token', '<input id="f" type="text" name="csrf_token">'],
    ['name contains cvv', '<input id="f" type="text" name="card-cvv">'],
    ['name contains pin', '<input id="f" type="text" name="pin-code">'],
    ['name contains secret', '<textarea id="f" name="client_secret"></textarea>'],
  ])('redacts sensitive field: %s', (_label, html) => {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild as HTMLInputElement;
    el.value = 'sensitive-value-123';
    dispatchBlur(el);
    expect(lastPayload()).toMatchObject({ value: REDACTED_VALUE, redacted: true });
    expect(JSON.stringify(recordMock.mock.calls)).not.toContain('sensitive-value-123');
  });

  it('ignores blur on non-form elements', () => {
    document.body.innerHTML = '<div id="d" tabindex="0"></div>';
    dispatchBlur(document.getElementById('d')!);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('select capture on change', () => {
  it('sends the selected value', () => {
    document.body.innerHTML =
      '<select id="color"><option value="red">Red</option><option value="blue">Blue</option></select>';
    const select = document.getElementById('color') as HTMLSelectElement;
    select.value = 'blue';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(lastPayload()).toMatchObject({ kind: 'select', tag: 'select', value: 'blue' });
  });

  it('ignores change events from non-select elements', () => {
    document.body.innerHTML = '<input id="i" type="checkbox">';
    document.getElementById('i')!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('keydown capture', () => {
  it('records accessibility-critical keys with special-case names', () => {
    document.body.innerHTML = '<input id="field" type="text">';
    const input = document.getElementById('field') as HTMLInputElement;
    input.focus();
    dispatchKey(input, 'Tab');
    dispatchKey(input, 'Tab', true);
    dispatchKey(input, ' ');
    dispatchKey(input, 'Escape');
    dispatchKey(input, 'ArrowDown');
    const values = recordedPayloads().map((p) => p['value']);
    expect(values).toEqual(['Tab', 'Shift+Tab', 'Space', 'Escape', 'ArrowDown']);
    expect(recordedPayloads().every((p) => p['kind'] === 'key')).toBe(true);
  });

  it('ignores ordinary typing keys', () => {
    document.body.innerHTML = '<input id="field" type="text">';
    const input = document.getElementById('field')!;
    dispatchKey(input, 'a');
    dispatchKey(input, 'Backspace');
    dispatchKey(input, 'F5');
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('auth suspicion via focusin', () => {
  it('reports password-field focus over the auth bridge', () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    document
      .getElementById('pw')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(authSuspectMock).toHaveBeenCalledTimes(1);
    const payload = authSuspectMock.mock.calls[0]![0] as Payload;
    expect(payload['reason']).toBe('password-field');
    expect(typeof payload['url']).toBe('string');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('stays silent for non-password focus', () => {
    document.body.innerHTML = '<input id="txt" type="text">';
    document
      .getElementById('txt')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(authSuspectMock).not.toHaveBeenCalled();
  });
});

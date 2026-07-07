// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TargetCandidate } from '@waa/shared';
import {
  buildInPageSelectorScript,
  describeTarget,
  sanitizeCandidates,
} from './selector-engine.js';

type CandidateFn = (el: unknown) => Array<Record<string, unknown>>;

function getCandidates(el: unknown): Array<Record<string, unknown>> {
  const fn = (window as unknown as Record<string, unknown>)
    .__waaGetTargetCandidates as CandidateFn;
  return fn(el);
}

function strategies(el: unknown): string[] {
  return getCandidates(el).map((c) => c['strategy'] as string);
}

beforeAll(() => {
  // Indirect eval so the script runs against the jsdom globals, exactly like
  // an addInitScript would run against the real page.
  (0, eval)(buildInPageSelectorScript());
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildInPageSelectorScript', () => {
  it('installs a function and never throws on junk input', () => {
    expect(getCandidates(null)).toEqual([]);
    expect(getCandidates(undefined)).toEqual([]);
    expect(getCandidates({ nodeType: 9 })).toEqual([]);
  });

  it('emits a testid candidate first when data-testid is present', () => {
    document.body.innerHTML = '<button data-testid="submit-button">Go</button>';
    const candidates = getCandidates(document.querySelector('button'));
    expect(candidates[0]).toEqual({
      strategy: 'testid',
      attribute: 'data-testid',
      value: 'submit-button',
    });
  });

  it('falls back through data-test and data-qa in order', () => {
    document.body.innerHTML = '<div data-qa="qa-el" data-test="test-el"></div>';
    const candidates = getCandidates(document.querySelector('div'));
    expect(candidates[0]).toEqual({ strategy: 'testid', attribute: 'data-test', value: 'test-el' });
  });

  it('emits a stable id candidate', () => {
    document.body.innerHTML = '<nav id="main-nav"></nav>';
    const candidates = getCandidates(document.querySelector('nav'));
    expect(candidates).toContainEqual({ strategy: 'id', value: 'main-nav' });
  });

  it('rejects auto-generated-looking ids', () => {
    for (const id of [':r1:', 'input-38472', 'radix-1a', 'ember123', '12345', '__2__']) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
      expect(strategies(el), `id "${id}" should be rejected`).not.toContain('id');
      el.remove();
    }
  });

  it('emits role+name and text candidates for a button with text', () => {
    document.body.innerHTML = '<button>Submit</button>';
    const candidates = getCandidates(document.querySelector('button'));
    expect(candidates).toContainEqual({ strategy: 'role', role: 'button', name: 'Submit' });
    expect(candidates).toContainEqual({ strategy: 'text', value: 'Submit', tag: 'button' });
    const order = candidates.map((c) => c['strategy']);
    expect(order.indexOf('role')).toBeLessThan(order.indexOf('text'));
  });

  it('uses aria-label over textContent for the accessible name', () => {
    document.body.innerHTML = '<button aria-label="Close dialog">X</button>';
    const candidates = getCandidates(document.querySelector('button'));
    expect(candidates).toContainEqual({ strategy: 'role', role: 'button', name: 'Close dialog' });
  });

  it('derives textbox role and label[for] name for inputs', () => {
    document.body.innerHTML =
      '<label for="email">Email address</label><input id="email" type="email">';
    const candidates = getCandidates(document.querySelector('input'));
    expect(candidates).toContainEqual({
      strategy: 'role',
      role: 'textbox',
      name: 'Email address',
    });
  });

  it('maps common implicit roles (link, checkbox, combobox, heading)', () => {
    document.body.innerHTML = [
      '<a href="/x" title="home link">Home</a>',
      '<input type="checkbox" aria-label="Agree">',
      '<select aria-label="Country"></select>',
      '<h2 title="Section heading">Intro</h2>',
    ].join('');
    const roleOf = (sel: string): unknown =>
      getCandidates(document.querySelector(sel)).find((c) => c['strategy'] === 'role');
    expect(roleOf('a')).toMatchObject({ role: 'link', name: 'Home' });
    expect(roleOf('input')).toMatchObject({ role: 'checkbox', name: 'Agree' });
    expect(roleOf('select')).toMatchObject({ role: 'combobox', name: 'Country' });
    expect(roleOf('h2')).toMatchObject({ role: 'heading', name: 'Section heading' });
  });

  it('rejects utility classes but emits a unique css selector from semantic ones', () => {
    document.body.innerHTML =
      '<nav><a href="/a" class="hover:underline w-[100px] md:flex !mt-2 css-1q2w breadcrumb-link">Item 1</a></nav>';
    const candidates = getCandidates(document.querySelector('a'));
    const css = candidates.find((c) => c['strategy'] === 'css');
    expect(css).toEqual({ strategy: 'css', value: 'a.breadcrumb-link' });
  });

  it('anchors the css selector on the parent when the class alone is ambiguous', () => {
    document.body.innerHTML =
      '<header class="site-header"><a href="/a" class="nav-link">A</a></header>' +
      '<footer class="site-footer"><a href="/b" class="nav-link">B</a></footer>';
    const candidates = getCandidates(document.querySelector('footer a'));
    const css = candidates.find((c) => c['strategy'] === 'css');
    expect(css).toEqual({ strategy: 'css', value: 'footer.site-footer > a.nav-link' });
  });

  it('omits the css candidate when no unique stable selector exists', () => {
    document.body.innerHTML =
      '<div><span class="cell">x</span><span class="cell">y</span></div>';
    const candidates = getCandidates(document.querySelectorAll('span')[1]);
    expect(candidates.map((c) => c['strategy'])).not.toContain('css');
  });

  it('emits only an nth-path for a deep anonymous element', () => {
    document.body.innerHTML = '<div><div><span>plain</span></div></div>';
    const candidates = getCandidates(document.querySelector('span'));
    expect(candidates).toEqual([
      {
        strategy: 'nth-path',
        value: 'div:nth-child(1) > div:nth-child(1) > span:nth-child(1)',
      },
    ]);
  });

  it('caps the nth-path depth at 12 segments', () => {
    let html = '<i>deep</i>';
    for (let i = 0; i < 20; i++) html = `<div>${html}</div>`;
    document.body.innerHTML = html;
    const candidates = getCandidates(document.querySelector('i'));
    const nth = candidates.find((c) => c['strategy'] === 'nth-path');
    expect((nth?.['value'] as string).split(' > ')).toHaveLength(12);
  });

  it('orders candidates testid > id > role > text > css > nth-path', () => {
    document.body.innerHTML =
      '<button id="submit-btn" data-testid="submit" class="btn-primary hover:bg-blue-500">Submit</button>';
    expect(strategies(document.querySelector('button'))).toEqual([
      'testid',
      'id',
      'role',
      'text',
      'css',
      'nth-path',
    ]);
  });

  it('resolves text nodes to their parent element', () => {
    document.body.innerHTML = '<button>Click me</button>';
    const textNode = document.querySelector('button')!.firstChild;
    const candidates = getCandidates(textNode);
    expect(candidates).toContainEqual({ strategy: 'text', value: 'Click me', tag: 'button' });
  });

  it('skips text candidates longer than 80 chars', () => {
    document.body.innerHTML = `<a href="/x">${'y'.repeat(81)}</a>`;
    expect(strategies(document.querySelector('a'))).not.toContain('text');
  });
});

describe('sanitizeCandidates', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeCandidates(null)).toEqual([]);
    expect(sanitizeCandidates(undefined)).toEqual([]);
    expect(sanitizeCandidates('nope')).toEqual([]);
    expect(sanitizeCandidates({ strategy: 'id', value: 'x' })).toEqual([]);
  });

  it('drops entries that do not match the schema and keeps valid ones', () => {
    const raw = [
      { strategy: 'id', value: 'main-nav' },
      { strategy: 'bogus', value: 'x' },
      42,
      null,
      { strategy: 'role', role: 'button' }, // missing name
      { strategy: 'text', value: 'Hello' },
    ];
    expect(sanitizeCandidates(raw)).toEqual([
      { strategy: 'id', value: 'main-nav' },
      { strategy: 'text', value: 'Hello' },
    ]);
  });

  it('caps the list at 6 candidates', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      strategy: 'nth-path',
      value: `div:nth-child(${i + 1})`,
    }));
    expect(sanitizeCandidates(raw)).toHaveLength(6);
  });

  it('caps every string field at 200 chars', () => {
    const long = 'x'.repeat(500);
    const raw = [
      { strategy: 'role', role: long, name: long },
      { strategy: 'testid', attribute: long, value: long },
      { strategy: 'text', value: long, tag: long },
      { strategy: 'css', value: long },
    ];
    for (const candidate of sanitizeCandidates(raw)) {
      for (const v of Object.values(candidate)) {
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(200);
      }
    }
  });
});

describe('describeTarget', () => {
  it("prefers role+name: button 'Submit'", () => {
    const candidates: TargetCandidate[] = [
      { strategy: 'testid', attribute: 'data-testid', value: 'submit' },
      { strategy: 'role', role: 'button', name: 'Submit' },
      { strategy: 'nth-path', value: 'div:nth-child(1)' },
    ];
    expect(describeTarget(candidates)).toBe("button 'Submit'");
  });

  it('renders ids as #id', () => {
    const candidates: TargetCandidate[] = [
      { strategy: 'id', value: 'main-nav' },
      { strategy: 'nth-path', value: 'nav:nth-child(2)' },
    ];
    expect(describeTarget(candidates)).toBe('#main-nav');
  });

  it('renders text candidates with their tag', () => {
    const candidates: TargetCandidate[] = [
      { strategy: 'text', value: 'Read more', tag: 'a' },
    ];
    expect(describeTarget(candidates)).toBe("a 'Read more'");
  });

  it('renders css selectors verbatim and testids as attribute selectors', () => {
    expect(describeTarget([{ strategy: 'css', value: 'a.breadcrumb-link' }])).toBe(
      'a.breadcrumb-link',
    );
    expect(
      describeTarget([{ strategy: 'testid', attribute: 'data-qa', value: 'row-3' }]),
    ).toBe('[data-qa="row-3"]');
  });

  it('shows only the deepest nth-path segment', () => {
    expect(
      describeTarget([
        { strategy: 'nth-path', value: 'div:nth-child(2) > span:nth-child(1)' },
      ]),
    ).toBe('span:nth-child(1)');
  });

  it("falls back to 'element' when empty and clips long names", () => {
    expect(describeTarget([])).toBe('element');
    const described = describeTarget([
      { strategy: 'role', role: 'button', name: 'z'.repeat(100) },
    ]);
    expect(described.length).toBeLessThan(80);
    expect(described).toContain('…');
  });
});

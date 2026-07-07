import { describe, it, expect } from 'vitest';
import { scrubHtmlForAnalysis, scrubSensitiveValues } from './html-scrub.js';

describe('scrubHtmlForAnalysis', () => {
  it('removes script tags and their content', () => {
    const html = '<div>keep</div><script>var secret = "x";</script><p>also keep</p>';
    const out = scrubHtmlForAnalysis(html);
    expect(out).not.toContain('script');
    expect(out).not.toContain('secret');
    expect(out).toContain('<div>keep</div>');
    expect(out).toContain('<p>also keep</p>');
  });

  it('removes style tags and their content', () => {
    const html = '<style>.a { color: red; }</style><main>content</main>';
    const out = scrubHtmlForAnalysis(html);
    expect(out).not.toContain('color: red');
    expect(out).toContain('<main>content</main>');
  });

  it('removes link tags', () => {
    const html = '<link rel="stylesheet" href="/app.css"><h1>Title</h1>';
    const out = scrubHtmlForAnalysis(html);
    expect(out).not.toContain('<link');
    expect(out).toContain('<h1>Title</h1>');
  });

  it('removes most meta tags but keeps charset/viewport/og (legacy behavior)', () => {
    const html = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width">',
      '<meta property="og:title" content="T">',
      '<meta name="generator" content="WordPress">',
      '<body>x</body>',
    ].join('');
    const out = scrubHtmlForAnalysis(html);
    expect(out).toContain('charset');
    expect(out).toContain('viewport');
    expect(out).toContain('og:title');
    expect(out).not.toContain('generator');
  });

  it('removes HTML comments', () => {
    const html = '<div>a</div><!-- tracking pixel here --><div>b</div>';
    const out = scrubHtmlForAnalysis(html);
    expect(out).not.toContain('tracking pixel');
    expect(out).not.toContain('<!--');
  });

  it('collapses runs of 3+ whitespace characters', () => {
    const html = '<div>a</div>      <div>b</div>';
    const out = scrubHtmlForAnalysis(html);
    expect(out).toBe('<div>a</div> <div>b</div>');
  });

  it('does not throw on malformed html', () => {
    expect(() => scrubHtmlForAnalysis('<div <script no-close <<< "')).not.toThrow();
    expect(() => scrubHtmlForAnalysis('')).not.toThrow();
  });
});

describe('scrubSensitiveValues', () => {
  it('empties password input values', () => {
    const out = scrubSensitiveValues('<input type="password" name="pw" value="hunter2">');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('value=""');
    expect(out).toContain('type="password"');
  });

  it('empties text input values', () => {
    const out = scrubSensitiveValues('<input type="text" value="John Doe" id="name">');
    expect(out).not.toContain('John Doe');
    expect(out).toContain('value=""');
    expect(out).toContain('id="name"');
  });

  it('empties email, tel, number and search input values', () => {
    const html = [
      '<input type="email" value="a@b.com">',
      '<input type="tel" value="+3312345678">',
      '<input type="number" value="1234">',
      '<input type="search" value="my query">',
    ].join('\n');
    const out = scrubSensitiveValues(html);
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('+3312345678');
    expect(out).not.toContain('"1234"');
    expect(out).not.toContain('my query');
    expect(out.match(/value=""/g)).toHaveLength(4);
  });

  it('treats inputs without a type attribute as text (scrubbed)', () => {
    const out = scrubSensitiveValues('<input name="q" value="typed stuff">');
    expect(out).not.toContain('typed stuff');
    expect(out).toContain('value=""');
  });

  it('keeps checkbox, radio, hidden, submit and button values', () => {
    const html = [
      '<input type="checkbox" value="opt-in" checked>',
      '<input type="radio" value="blue">',
      '<input type="hidden" name="csrf" value="tok123">',
      '<input type="submit" value="Send">',
      '<input type="button" value="Cancel">',
    ].join('\n');
    const out = scrubSensitiveValues(html);
    expect(out).toContain('value="opt-in"');
    expect(out).toContain('value="blue"');
    expect(out).toContain('value="tok123"');
    expect(out).toContain('value="Send"');
    expect(out).toContain('value="Cancel"');
  });

  it('handles single-quoted and unquoted values', () => {
    const out = scrubSensitiveValues(
    `<input type='text' value='secret one'><input type=text value=secret2>`,
    );
    expect(out).not.toContain('secret one');
    expect(out).not.toContain('secret2');
  });

  it('blanks textarea inner text but keeps the tags and attributes', () => {
    const out = scrubSensitiveValues(
      '<textarea id="bio" rows="4">My private\nmultiline notes</textarea>',
    );
    expect(out).toBe('<textarea id="bio" rows="4"></textarea>');
  });

  it('strips data-value attributes', () => {
    const out = scrubSensitiveValues(
      '<div class="autocomplete" data-value="typed@email.com">suggestion</div>',
    );
    expect(out).not.toContain('typed@email.com');
    expect(out).not.toContain('data-value');
    expect(out).toContain('class="autocomplete"');
    expect(out).toContain('suggestion');
  });

  it('is idempotent', () => {
    const html = [
      '<input type="password" value="pw">',
      '<input type="checkbox" value="keep">',
      '<textarea>text</textarea>',
      '<li data-value="x">item</li>',
    ].join('');
    const once = scrubSensitiveValues(html);
    const twice = scrubSensitiveValues(once);
    expect(twice).toBe(once);
  });

  it('does not throw on malformed html and leaves non-form content alone', () => {
    expect(() => scrubSensitiveValues('<input type="text" value="unclosed')).not.toThrow();
    expect(() => scrubSensitiveValues('')).not.toThrow();
    const untouched = '<article><h2>Hello</h2><p>World</p></article>';
    expect(scrubSensitiveValues(untouched)).toBe(untouched);
  });
});

// src/utils.test.js
import { describe, expect, it } from 'vitest';
import { escapeHTML } from './utils.js';

describe('escapeHTML — escapa comillas (evita attribute-breakout XSS)', () => {
  it('escapa comillas dobles', () => {
    expect(escapeHTML('Foo" onmouseover="alert(1)')).toBe('Foo&quot; onmouseover=&quot;alert(1)');
  });

  it('escapa comillas simples', () => {
    expect(escapeHTML("O'Brien")).toBe('O&#39;Brien');
  });

  it('sigue escapando &, < y >', () => {
    expect(escapeHTML('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHTML('A & B')).toBe('A &amp; B');
  });

  it('nombre de cliente con comilla no rompe un atributo HTML', () => {
    const nombre = 'Foo" onmouseover="fetch(\'https://evil.example\')';
    const html = `<div data-search="${escapeHTML(nombre)}">`;
    expect(html).not.toContain('onmouseover="fetch');
    expect(html).toBe('<div data-search="Foo&quot; onmouseover=&quot;fetch(&#39;https://evil.example&#39;)">');
  });
});

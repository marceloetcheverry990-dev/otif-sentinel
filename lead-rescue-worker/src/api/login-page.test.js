import { describe, expect, it } from 'vitest';
import { handleLoginPage } from './login-page.js';

describe('handleLoginPage', () => {
  it('usa cookie HttpOnly sin exponer el token a JavaScript', async () => {
    const response = handleLoginPage(
      new Request('https://worker.test/login'),
      {},
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain("credentials: 'same-origin'");
    expect(html).not.toContain('sessionStorage');
    expect(html).not.toContain('operator_token');
    expect(html).not.toContain('data.token');
  });
});

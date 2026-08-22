import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestAddresses } from './geocode.js';

describe('suggestAddresses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deduplica variantes repetidas de Plaza Maipu', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (!u.includes('arcgis.com')) throw new Error('unexpected url ' + u);
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              address: 'Plaza Maipú, Maipú, Santiago',
              location: { y: -33.5091, x: -70.7578 },
              score: 99,
              attributes: { Addr_type: 'POI', AddNum: '' },
            },
            {
              address: 'Plaza Maipu, Santiago',
              location: { y: -33.5092, x: -70.7577 },
              score: 97,
              attributes: { Addr_type: 'POI', AddNum: '' },
            },
          ],
        }),
      };
    }));

    const got = await suggestAddresses('plaza maipu', {}, { limit: 7 });
    expect(got).toHaveLength(1);
    expect(got[0].display).toContain('Plaza Maip');
  });

  it('prioriza Plaza Maipu sobre Pasaje Plaza', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (!u.includes('arcgis.com')) throw new Error('unexpected url ' + u);
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              address: 'Pasaje Plaza, Maipú, Santiago, Metropolitana de Santiago',
              location: { y: -33.5081, x: -70.7568 },
              score: 100,
              attributes: { Addr_type: 'StreetName', AddNum: '' },
            },
            {
              address: 'Plaza Maipú, Maipú, Santiago, Metropolitana de Santiago',
              location: { y: -33.5091, x: -70.7578 },
              score: 80,
              attributes: { Addr_type: 'POI', AddNum: '' },
            },
          ],
        }),
      };
    }));

    const got = await suggestAddresses('plasa maipu', {}, { limit: 7 });
    expect(got).toHaveLength(2);
    expect(got[0].display).toContain('Plaza Maip');
    expect(got[1].display).toContain('Pasaje Plaza');
  });
});

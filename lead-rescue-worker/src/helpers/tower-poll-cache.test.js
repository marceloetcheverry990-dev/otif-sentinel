/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  setViajesPollCacheEntry,
  getViajesPollCacheEntry,
  invalidateTowerPoll,
  setLiveFleetCacheEntry,
  getLiveFleetCacheEntry,
} from './tower-poll-cache.js';

describe('tower-poll-cache', () => {
  it('invalida cache de viajes y gps por tenant', () => {
    setViajesPollCacheEntry('empresa_base|sla=0', '{"viajes":[]}');
    setLiveFleetCacheEntry('empresa_base', '{"flota":[]}');

    expect(getViajesPollCacheEntry('empresa_base|sla=0')).not.toBeNull();
    expect(getLiveFleetCacheEntry('empresa_base')).not.toBeNull();

    invalidateTowerPoll('empresa_base');

    expect(getViajesPollCacheEntry('empresa_base|sla=0')).toBeNull();
    expect(getLiveFleetCacheEntry('empresa_base')).toBeNull();
  });
});

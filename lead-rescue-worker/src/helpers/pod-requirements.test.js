import { describe, expect, it } from 'vitest';
import {
  isPodScanEnabled,
  resolvePodRequirements,
} from './pod-requirements.js';

describe('pod-requirements pilot flags', () => {
  it('isPodScanEnabled defaults false', () => {
    expect(isPodScanEnabled({})).toBe(false);
    expect(isPodScanEnabled({ POD_SCAN_ENABLED: 'false' })).toBe(false);
    expect(isPodScanEnabled({ POD_SCAN_ENABLED: 'true' })).toBe(true);
  });

  it('resolvePodRequirements forces scan off when POD_SCAN_ENABLED=false', () => {
    const req = resolvePodRequirements({
      tenantSettings: { pod_requirements: { foto: true, firma: true, scan: true } },
      env: { POD_SCAN_ENABLED: 'false' },
    });
    expect(req.scan).toBe(false);
    expect(req.foto).toBe(true);
  });

  it('resolvePodRequirements keeps scan when POD_SCAN_ENABLED=true', () => {
    const req = resolvePodRequirements({
      tenantSettings: { pod_requirements: { scan: true } },
      env: { POD_SCAN_ENABLED: 'true' },
    });
    expect(req.scan).toBe(true);
  });
});

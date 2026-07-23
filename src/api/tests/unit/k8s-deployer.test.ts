import { describe, expect, it } from 'vitest';
import { isKubernetesInfrastructureUnavailable } from '../../src/engine/k8s-deployer.js';

describe('Kubernetes infrastructure error classification', () => {
  it('should classify nested connection failures as infrastructure outages', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    });

    expect(isKubernetesInfrastructureUnavailable(error)).toBe(true);
  });

  it('should classify unavailable Kubernetes API responses as infrastructure outages', () => {
    expect(
      isKubernetesInfrastructureUnavailable({
        statusCode: 503,
        message: 'Service Unavailable',
      }),
    ).toBe(true);
  });

  it('should not classify application rollout failures as cluster outages', () => {
    expect(
      isKubernetesInfrastructureUnavailable(
        new Error('Deployment did not become ready within 3 minutes.'),
      ),
    ).toBe(false);
    expect(
      isKubernetesInfrastructureUnavailable({
        statusCode: 403,
        message: 'Forbidden',
      }),
    ).toBe(false);
  });
});

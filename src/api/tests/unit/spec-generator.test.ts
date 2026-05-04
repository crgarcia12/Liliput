import { describe, it, expect } from 'vitest';
import { extractGherkin } from '../../src/engine/spec-generator.js';

describe('extractGherkin', () => {
  it('extracts a gherkin block with Feature + Scenario', () => {
    const spec = `# Spec

## Acceptance Scenarios (Gherkin)
\`\`\`gherkin
Feature: Login

  Scenario: Valid credentials
    Given a registered user
    When they submit valid credentials
    Then they land on the dashboard
\`\`\`
`;
    const g = extractGherkin(spec);
    expect(g).not.toBeNull();
    expect(g).toContain('Feature: Login');
    expect(g).toContain('Scenario: Valid credentials');
  });

  it('returns null when no fenced gherkin block is present', () => {
    expect(extractGherkin('# Spec\n\nNo gherkin here.')).toBeNull();
  });

  it('returns null when the gherkin block has no Scenario keyword', () => {
    const spec = '```gherkin\nFeature: Empty\n```';
    expect(extractGherkin(spec)).toBeNull();
  });

  it('also accepts ```feature as the language hint', () => {
    const spec = '```feature\nFeature: X\n  Scenario: Y\n    Given Z\n```';
    expect(extractGherkin(spec)).toContain('Feature: X');
  });

  it('is case-insensitive on the Scenario keyword', () => {
    const spec = '```gherkin\nFeature: X\n  scenario: y\n    Given z\n```';
    expect(extractGherkin(spec)).toContain('Feature: X');
  });
});

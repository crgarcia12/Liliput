import { describe, expect, it } from 'vitest';
import {
  buildFollowUpPrompt,
  buildInitialPrompt,
  buildManagedPromptOverride,
  type RunAgentTurnOptions,
} from '../../src/engine/agent-loop.js';

const baseOptions: RunAgentTurnOptions = {
  taskTitle: 'Build the flight planner',
  taskDescription: 'Deliver an end-to-end IFR route planning application.',
  spec: [
    '# Specification: Flight planner',
    '- [ ] A pilot can create and save a route.',
  ].join('\n'),
  repository: 'crgarcia12/ifr-pilot',
  baseBranch: 'main',
  taskBranch: 'liliput/task-123',
  baseCommitSha: 'abc123',
  workspaceRoot: '/workspaces/ifr-pilot',
  isInitial: true,
};

describe('managed delivery prompts', () => {
  it('should inject immutable task and repository context into the initial turn', () => {
    const prompt = buildInitialPrompt(baseOptions);

    expect(prompt).toContain('Repository: crgarcia12/ifr-pilot');
    expect(prompt).toContain('Task branch: liliput/task-123');
    expect(prompt).toContain('Build the flight planner');
    expect(prompt).toContain('A pilot can create and save a route.');
    expect(prompt).toContain('working capability, not only plans, specs, docs');
  });

  it('should retain the original task and approved spec in every follow-up turn', () => {
    const prompt = buildFollowUpPrompt({
      ...baseOptions,
      isInitial: false,
      followUp: 'Fix the route save error and continue.',
    });

    expect(prompt).toContain('Repository: crgarcia12/ifr-pilot');
    expect(prompt).toContain('Deliver an end-to-end IFR route planning application.');
    expect(prompt).toContain('A pilot can create and save a route.');
    expect(prompt).toContain('Fix the route save error and continue.');
  });

  it('should separate implementation readiness from deployment verification', () => {
    const prompt = buildFollowUpPrompt({
      ...baseOptions,
      isInitial: false,
      followUp: 'Continue.',
    });

    expect(prompt).toContain(
      '`done` means the repository implementation is complete and locally verified',
    );
    expect(prompt).toContain(
      'It does NOT claim that deployment is already healthy',
    );
    expect(prompt).not.toContain('make a tiny no-op edit');
    expect(prompt).not.toContain('$ curl -fsS');
  });

  it('should prepend immutable task context to purpose-built fixer prompts', () => {
    const prompt = buildManagedPromptOverride(
      baseOptions,
      'Fix the failing build without changing unrelated behavior.',
    );

    expect(prompt).toContain('Repository: crgarcia12/ifr-pilot');
    expect(prompt).toContain('Task branch: liliput/task-123');
    expect(prompt).toContain('A pilot can create and save a route.');
    expect(prompt).toContain('Fix the failing build without changing unrelated behavior.');
  });
});

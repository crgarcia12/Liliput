import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTask,
  getTask,
  getTasks,
  updateTask,
  deleteTask,
  addAgent,
  updateAgent,
  getAgent,
  addAgentLog,
  addChatMessage,
  getChatHistory,
  resetStore,
} from '../../src/stores/task-store.js';

beforeEach(() => {
  resetStore();
});

describe('TaskStore — Tasks', () => {
  it('should create a task with clarifying status', () => {
    const task = createTask('Test Task', 'Do something');
    expect(task.id).toBeDefined();
    expect(task.title).toBe('Test Task');
    expect(task.description).toBe('Do something');
    expect(task.status).toBe('clarifying');
    expect(task.agents).toEqual([]);
    expect(task.chatHistory).toEqual([]);
    expect(task.createdAt).toBeDefined();
  });

  it('should get a task by id', () => {
    const task = createTask('T', 'D');
    const found = getTask(task.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(task.id);
  });

  it('should return undefined for missing task', () => {
    expect(getTask('nonexistent')).toBeUndefined();
  });

  it('should list all tasks', () => {
    createTask('A', 'a');
    createTask('B', 'b');
    expect(getTasks()).toHaveLength(2);
  });

  it('should update a task', () => {
    const task = createTask('T', 'D');
    const updated = updateTask(task.id, { status: 'building', spec: '# Spec' });
    expect(updated!.status).toBe('building');
    expect(updated!.spec).toBe('# Spec');
  });

  it('should return undefined when updating nonexistent task', () => {
    expect(updateTask('nope', { status: 'building' })).toBeUndefined();
  });

  it('should delete a task', () => {
    const task = createTask('T', 'D');
    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeUndefined();
  });

  it('should return false when deleting nonexistent task', () => {
    expect(deleteTask('nope')).toBe(false);
  });
});

describe('TaskStore — Agents', () => {
  it('should add an agent to a task', () => {
    const task = createTask('T', 'D');
    const agent = addAgent(task.id, 'Coder', 'coder');
    expect(agent).toBeDefined();
    expect(agent!.role).toBe('coder');
    expect(agent!.status).toBe('idle');
    expect(agent!.progress).toBe(0);
    expect(getTask(task.id)!.agents).toHaveLength(1);
  });

  it('should return undefined when adding agent to nonexistent task', () => {
    expect(addAgent('nope', 'Coder', 'coder')).toBeUndefined();
  });

  it('should update an agent', () => {
    const task = createTask('T', 'D');
    const agent = addAgent(task.id, 'Coder', 'coder')!;
    const updated = updateAgent(task.id, agent.id, { status: 'working', progress: 50 });
    expect(updated!.status).toBe('working');
    expect(updated!.progress).toBe(50);
  });

  it('should get an agent by id', () => {
    const task = createTask('T', 'D');
    const agent = addAgent(task.id, 'Coder', 'coder')!;
    expect(getAgent(task.id, agent.id)).toBeDefined();
    expect(getAgent(task.id, 'nope')).toBeUndefined();
  });

  it('should add a log entry to an agent', () => {
    const task = createTask('T', 'D');
    const agent = addAgent(task.id, 'Coder', 'coder')!;
    addAgentLog(task.id, agent.id, 'info', 'Building…', 'npm run build', 'ok');
    const found = getAgent(task.id, agent.id)!;
    expect(found.logs).toHaveLength(1);
    expect(found.logs[0].message).toBe('Building…');
    expect(found.logs[0].command).toBe('npm run build');
  });
});

describe('TaskStore — Chat', () => {
  it('should add a chat message', () => {
    const task = createTask('T', 'D');
    const msg = addChatMessage(task.id, 'gulliver', 'Hello');
    expect(msg).toBeDefined();
    expect(msg!.role).toBe('gulliver');
    expect(msg!.content).toBe('Hello');
  });

  it('should return undefined for nonexistent task', () => {
    expect(addChatMessage('nope', 'gulliver', 'Hello')).toBeUndefined();
  });

  it('should get chat history', () => {
    const task = createTask('T', 'D');
    addChatMessage(task.id, 'gulliver', 'Hi');
    addChatMessage(task.id, 'liliput', 'Hello!');
    expect(getChatHistory(task.id)).toHaveLength(2);
  });

  it('should return empty array for nonexistent task', () => {
    expect(getChatHistory('nope')).toEqual([]);
  });
});

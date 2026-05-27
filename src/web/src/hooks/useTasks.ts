'use client';

import { useCallback } from 'react';
import type {
  Task,
  CommitMode,
  CreateTaskRequest,
  TaskListResponse,
  TaskDetailResponse,
} from '@shared/types';

const API_URL = '';

interface CreateTaskOptions {
  repository?: string;
  baseBranch?: string;
  commitMode?: CommitMode;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  reviewerModel?: string;
  reviewerReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

interface UseTasksReturn {
  createTask: (title: string, description: string, options?: CreateTaskOptions) => Promise<Task>;
  getTasks: () => Promise<Task[]>;
  getTask: (id: string) => Promise<Task>;
  sendMessage: (taskId: string, message: string) => Promise<void>;
  approveSpec: (taskId: string) => Promise<void>;
  shipTask: (taskId: string) => Promise<Task>;
  discardTask: (taskId: string) => Promise<Task>;
  setTaskModel: (taskId: string, model: string) => Promise<Task>;
  setTaskReasoningEffort: (taskId: string, reasoningEffort: '' | 'low' | 'medium' | 'high' | 'xhigh') => Promise<Task>;
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => 'Unknown error');
    throw new Error(`API error ${res.status}: ${errorBody}`);
  }
  return res.json() as Promise<T>;
}

export function useTasks(): UseTasksReturn {
  const createTask = useCallback(
    async (title: string, description: string, options?: CreateTaskOptions): Promise<Task> => {
      const body: CreateTaskRequest = {
        title,
        description,
        repository: options?.repository,
        baseBranch: options?.baseBranch,
        commitMode: options?.commitMode,
        model: options?.model,
        reasoningEffort: options?.reasoningEffort,
        reviewerModel: options?.reviewerModel,
        reviewerReasoningEffort: options?.reviewerReasoningEffort,
      };
      const data = await apiRequest<TaskDetailResponse>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return data.task;
    },
    [],
  );

  const getTasks = useCallback(async (): Promise<Task[]> => {
    const data = await apiRequest<TaskListResponse>('/api/tasks');
    return data.tasks;
  }, []);

  const getTask = useCallback(async (id: string): Promise<Task> => {
    const data = await apiRequest<TaskDetailResponse>(`/api/tasks/${id}`);
    return data.task;
  }, []);

  const sendMessage = useCallback(async (taskId: string, message: string): Promise<void> => {
    await apiRequest<unknown>(`/api/tasks/${taskId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }, []);

  const approveSpec = useCallback(async (taskId: string): Promise<void> => {
    await apiRequest<unknown>(`/api/tasks/${taskId}/approve`, {
      method: 'POST',
    });
  }, []);

  const shipTask = useCallback(async (taskId: string): Promise<Task> => {
    const data = await apiRequest<TaskDetailResponse>(`/api/tasks/${taskId}/ship`, {
      method: 'POST',
    });
    return data.task;
  }, []);

  const discardTask = useCallback(async (taskId: string): Promise<Task> => {
    const data = await apiRequest<TaskDetailResponse>(`/api/tasks/${taskId}/discard`, {
      method: 'POST',
    });
    return data.task;
  }, []);

  const setTaskModel = useCallback(async (taskId: string, model: string): Promise<Task> => {
    const data = await apiRequest<TaskDetailResponse>(`/api/tasks/${taskId}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    });
    return data.task;
  }, []);

  const setTaskReasoningEffort = useCallback(
    async (
      taskId: string,
      reasoningEffort: '' | 'low' | 'medium' | 'high' | 'xhigh',
    ): Promise<Task> => {
      const data = await apiRequest<TaskDetailResponse>(
        `/api/tasks/${taskId}/reasoning-effort`,
        {
          method: 'PATCH',
          body: JSON.stringify({ reasoningEffort: reasoningEffort === '' ? null : reasoningEffort }),
        },
      );
      return data.task;
    },
    [],
  );

  return { createTask, getTasks, getTask, sendMessage, approveSpec, shipTask, discardTask, setTaskModel, setTaskReasoningEffort };
}


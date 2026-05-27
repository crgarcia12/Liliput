'use client';

import type { ReasoningEffort } from '@shared/types';

export const CHAT_CONFIG_STORAGE_KEYS = {
  model: 'liliput:lastModel',
  reasoningEffort: 'liliput:lastReasoningEffort',
  reviewerModel: 'liliput:lastReviewerModel',
  reviewerReasoningEffort: 'liliput:lastReviewerReasoningEffort',
} as const;

export type ChatConfigStorageKey =
  (typeof CHAT_CONFIG_STORAGE_KEYS)[keyof typeof CHAT_CONFIG_STORAGE_KEYS];

export const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffortSelection = '' | ReasoningEffort;

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readStoredString(key: ChatConfigStorageKey): string {
  if (!hasLocalStorage()) return '';
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function readStoredEffort(key: ChatConfigStorageKey): ReasoningEffortSelection {
  const raw = readStoredString(key);
  return (EFFORT_VALUES as readonly string[]).includes(raw)
    ? (raw as ReasoningEffortSelection)
    : '';
}

export function writeStoredString(key: ChatConfigStorageKey, value: string): void {
  if (!hasLocalStorage()) return;
  try {
    if (value === '') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Non-fatal: the current chat still uses the selected value.
  }
}

export function rememberChatConfig(config: {
  model?: string | null;
  reasoningEffort?: ReasoningEffortSelection | null;
  reviewerModel?: string | null;
  reviewerReasoningEffort?: ReasoningEffortSelection | null;
}): void {
  if (config.model !== undefined) {
    writeStoredString(CHAT_CONFIG_STORAGE_KEYS.model, config.model ?? '');
  }
  if (config.reasoningEffort !== undefined) {
    writeStoredString(
      CHAT_CONFIG_STORAGE_KEYS.reasoningEffort,
      config.reasoningEffort ?? '',
    );
  }
  if (config.reviewerModel !== undefined) {
    writeStoredString(CHAT_CONFIG_STORAGE_KEYS.reviewerModel, config.reviewerModel ?? '');
  }
  if (config.reviewerReasoningEffort !== undefined) {
    writeStoredString(
      CHAT_CONFIG_STORAGE_KEYS.reviewerReasoningEffort,
      config.reviewerReasoningEffort ?? '',
    );
  }
}

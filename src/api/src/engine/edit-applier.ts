/**
 * Apply structured file-edit operations produced by the LLM to a workspace.
 *
 * Operation schema (one of):
 *   { op: 'write',  path: string, content: string }      — create or overwrite
 *   { op: 'append', path: string, content: string }      — append to existing
 *   { op: 'delete', path: string }                       — remove a file
 *   { op: 'mkdir',  path: string }                       — create a directory
 *
 * Paths are always relative to the workspace root. Absolute paths or paths
 * containing `..` segments are rejected.
 */

import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export type EditOp =
  | { op: 'write'; path: string; content: string }
  | { op: 'append'; path: string; content: string }
  | { op: 'delete'; path: string }
  | { op: 'mkdir'; path: string };

export interface EditPlan {
  /** Optional human-readable explanation. */
  summary?: string;
  /** True when the agent has nothing more to do. */
  done?: boolean;
  ops: EditOp[];
}

export interface ApplyResult {
  changedFiles: string[];
  errors: { path: string; op: string; message: string }[];
}

const MAX_FILES_PER_BATCH = 100;
const MAX_BYTES_PER_FILE = 1024 * 1024; // 1 MiB

function safeJoin(root: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`Path must be relative: ${rel}`);
  }
  const normalised = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalised.startsWith('..') || normalised.includes('/../')) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  if (normalised === '.git' || normalised.startsWith('.git/')) {
    throw new Error(`Refusing to modify .git: ${rel}`);
  }
  return path.join(root, normalised);
}

export function isEditOp(value: unknown): value is EditOp {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['path'] !== 'string') return false;
  switch (v['op']) {
    case 'write':
    case 'append':
      return typeof v['content'] === 'string';
    case 'delete':
    case 'mkdir':
      return true;
    default:
      return false;
  }
}

export function isEditPlan(value: unknown): value is EditPlan {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['ops'])) return false;
  return (v['ops'] as unknown[]).every(isEditOp);
}

export async function applyEditPlan(
  workspaceRoot: string,
  plan: EditPlan,
): Promise<ApplyResult> {
  const changedFiles: string[] = [];
  const errors: ApplyResult['errors'] = [];

  if (plan.ops.length > MAX_FILES_PER_BATCH) {
    throw new Error(
      `Edit plan exceeds ${MAX_FILES_PER_BATCH} ops (got ${plan.ops.length})`,
    );
  }

  for (const op of plan.ops) {
    try {
      const absolute = safeJoin(workspaceRoot, op.path);

      switch (op.op) {
        case 'mkdir':
          await mkdir(absolute, { recursive: true });
          changedFiles.push(op.path);
          break;

        case 'delete': {
          await rm(absolute, { recursive: true, force: true });
          changedFiles.push(op.path);
          break;
        }

        case 'write': {
          if (Buffer.byteLength(op.content, 'utf8') > MAX_BYTES_PER_FILE) {
            throw new Error(`File exceeds ${MAX_BYTES_PER_FILE} bytes`);
          }
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, op.content, 'utf8');
          changedFiles.push(op.path);
          break;
        }

        case 'append': {
          await mkdir(path.dirname(absolute), { recursive: true });
          let existing = '';
          try {
            const s = await stat(absolute);
            if (s.isFile()) existing = await readFile(absolute, 'utf8');
          } catch {
            /* file may not exist yet — append == create */
          }
          const next = existing + op.content;
          if (Buffer.byteLength(next, 'utf8') > MAX_BYTES_PER_FILE) {
            throw new Error(`File would exceed ${MAX_BYTES_PER_FILE} bytes`);
          }
          await writeFile(absolute, next, 'utf8');
          changedFiles.push(op.path);
          break;
        }
      }
    } catch (err) {
      errors.push({
        path: op.path,
        op: op.op,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { changedFiles, errors };
}

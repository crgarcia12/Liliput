import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseToolWishes,
  recordToolWish,
  listToolWishes,
  aggregateToolWishes,
} from '../../src/stores/tool-wish-store.js';
import { resetStore, createTask } from '../../src/stores/task-store.js';

beforeEach(() => {
  resetStore();
});

describe('parseToolWishes', () => {
  it('parses a single TOOL-WISH line', () => {
    const out = parseToolWishes('TOOL-WISH: jq — parse kubectl json output');
    expect(out).toEqual([{ tool: 'jq', reason: 'parse kubectl json output' }]);
  });

  it('parses multiple wishes in one block', () => {
    const text = `Some thinking…
TOOL-WISH: jq — for parsing
TOOL-WISH: yq -- for helm yaml
done.`;
    const out = parseToolWishes(text);
    expect(out).toHaveLength(2);
    expect(out[0]?.tool).toBe('jq');
    expect(out[1]?.tool).toBe('yq');
  });

  it('is case-insensitive on the prefix and accepts hyphen variants', () => {
    expect(parseToolWishes('tool-wish: ripgrep')).toHaveLength(1);
    expect(parseToolWishes('Tool_Wish: bat — better cat')).toHaveLength(1);
    expect(parseToolWishes('TOOL WISH: fd')).toHaveLength(1);
  });

  it('returns empty for unrelated text', () => {
    expect(parseToolWishes('I wish I had a tool for this')).toEqual([]);
    expect(parseToolWishes('')).toEqual([]);
  });

  it('lowercases tool names but preserves reason casing', () => {
    const out = parseToolWishes('TOOL-WISH: JQ — Parse JSON');
    expect(out[0]?.tool).toBe('jq');
    expect(out[0]?.reason).toBe('Parse JSON');
  });

  it('handles wish with no reason', () => {
    const out = parseToolWishes('TOOL-WISH: jq');
    expect(out).toEqual([{ tool: 'jq', reason: null }]);
  });
});

describe('tool wish store', () => {
  it('records and lists wishes', () => {
    const t = createTask('T', 'D');
    recordToolWish(t.id, null, 'jq', 'parse json');
    recordToolWish(t.id, null, 'yq', 'parse yaml');
    const all = listToolWishes();
    expect(all).toHaveLength(2);
    expect(all.map((w) => w.tool).sort()).toEqual(['jq', 'yq']);
  });

  it('dedupes within the same minute for the same task+tool', () => {
    const t = createTask('T', 'D');
    const first = recordToolWish(t.id, null, 'jq', 'reason 1');
    const dup = recordToolWish(t.id, null, 'jq', 'reason 2');
    expect(first).not.toBeNull();
    expect(dup).toBeNull(); // suppressed
    expect(listToolWishes()).toHaveLength(1);
  });

  it('aggregates by tool with count and unique reasons', () => {
    const t1 = createTask('T1', 'D');
    const t2 = createTask('T2', 'D');
    recordToolWish(t1.id, null, 'jq', 'parse kubectl');
    recordToolWish(t2.id, null, 'jq', 'parse helm output');
    recordToolWish(t1.id, null, 'yq', null);
    const agg = aggregateToolWishes();
    expect(agg).toHaveLength(2);
    const jq = agg.find((a) => a.tool === 'jq')!;
    expect(jq.count).toBe(2);
    expect(jq.taskIds).toHaveLength(2);
    expect(jq.reasons).toContain('parse kubectl');
    expect(jq.reasons).toContain('parse helm output');
  });
});

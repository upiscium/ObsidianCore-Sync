import { describe, expect, it } from 'vitest';
import { mergeMarkdown } from '../src/merge';

describe('mergeMarkdown', () => {
  it('returns identical changes cleanly and preserves exact text', () => {
    const text = '# Heading\r\n\r\nSame edit\r\n';
    expect(mergeMarkdown('# Heading\r\n', text, text)).toEqual({ clean: true, text });
  });

  it('takes a one-sided change without changing CRLF or trailing-newline state', () => {
    const base = 'one\r\ntwo';
    const local = 'ONE\r\ntwo';
    expect(mergeMarkdown(base, local, base)).toEqual({ clean: true, text: local });
    expect(mergeMarkdown(base, base, 'one\r\nTWO')).toEqual({ clean: true, text: 'one\r\nTWO' });
  });

  it('merges non-overlapping changes and preserves unicode', () => {
    const result = mergeMarkdown(
      'café\nsecond\nthird\n',
      'café local\nsecond\nthird\n',
      'café\nsecond\n三番目\n',
    );
    expect(result).toEqual({ clean: true, text: 'café local\nsecond\n三番目\n' });
  });

  it('merges adjacent base-span edits despite insert/delete position shifts', () => {
    const base = 'A\r\nB\r\nC\r\nD\r\n';
    expect(mergeMarkdown(base, 'A\r\nX\r\nB\r\nC\r\nD\r\n', 'A\r\nB\r\nC*\r\nD\r\n'))
      .toEqual({ clean: true, text: 'A\r\nX\r\nB\r\nC*\r\nD\r\n' });
    expect(mergeMarkdown(base, 'A\r\nC\r\nD\r\n', 'A\r\nB\r\nC*\r\nD\r\n'))
      .toEqual({ clean: true, text: 'A\r\nC*\r\nD\r\n' });
  });

  it('keeps matching insertions clean', () => {
    expect(mergeMarkdown('before\nafter\n', 'before\nnew\nafter\n', 'before\nnew\nafter\n'))
      .toEqual({ clean: true, text: 'before\nnew\nafter\n' });
  });

  it('blank-line regression: merges independent fills across three blank rows in either side order', () => {
    const base = '\n\n\n';
    const local = 'A\n\n\n';
    const remote = '\n\nB\n';

    expect(mergeMarkdown(base, local, remote)).toEqual({ clean: true, text: 'A\n\nB\n' });
    expect(mergeMarkdown(base, remote, local)).toEqual({ clean: true, text: 'A\n\nB\n' });
  });

  it('blank-line regression: preserves the exact blank-row count on a four-LF base', () => {
    const base = '\n\n\n\n';
    const local = 'A\n\n\n\n';
    const remote = '\n\nB\n\n';

    expect(mergeMarkdown(base, local, remote)).toEqual({ clean: true, text: 'A\n\nB\n\n' });
    expect(mergeMarkdown(base, remote, local)).toEqual({ clean: true, text: 'A\n\nB\n\n' });
  });

  it('blank-line regression: merges fills without inventing a final newline', () => {
    const base = '\n\n';
    const local = 'A\n\n';
    const remote = '\n\nB';

    expect(mergeMarkdown(base, local, remote)).toEqual({ clean: true, text: 'A\n\nB' });
    expect(mergeMarkdown(base, remote, local)).toEqual({ clean: true, text: 'A\n\nB' });
  });

  it('blank-line regression: preserves CRLF while merging independent blank-row fills', () => {
    const base = '\r\n\r\n\r\n';
    const local = 'A\r\n\r\n\r\n';
    const remote = '\r\n\r\nB\r\n';

    expect(mergeMarkdown(base, local, remote)).toEqual({ clean: true, text: 'A\r\n\r\nB\r\n' });
    expect(mergeMarkdown(base, remote, local)).toEqual({ clean: true, text: 'A\r\n\r\nB\r\n' });
  });

  it('blank-line regression: preserves mixed per-row endings in position-stable fills', () => {
    const base = '\r\n\n\r';
    const local = 'A\r\n\n\r';
    const remote = '\r\n\nB\r';

    expect(mergeMarkdown(base, local, remote)).toEqual({ clean: true, text: 'A\r\n\nB\r' });
    expect(mergeMarkdown(base, remote, local)).toEqual({ clean: true, text: 'A\r\n\nB\r' });
  });

  it('blank-line regression: conflicts on competing fills of the same blank row with exact hunks', () => {
    const result = mergeMarkdown('\n\n\n', 'local\n\n\n', 'remote\n\n\n');

    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.hunks).toEqual([{ base: '\n', local: 'local\n', remote: 'remote\n' }]);
    }
  });

  it('blank-line regression: rejects unequal blank-row deletion and insertion in either side order', () => {
    const base = '\n\n\n';
    const deletion = '\n\n';
    const insertion = '\n\n\n\n';

    expect(mergeMarkdown(base, deletion, insertion).clean).toBe(false);
    expect(mergeMarkdown(base, insertion, deletion).clean).toBe(false);
  });

  it('blank-line regression: preserves both exact variants when the virtual EOF row conflicts', () => {
    for (const [local, remote] of [['\n\nA', '\n\nB'], ['\n\nB', '\n\nA']]) {
      const result = mergeMarkdown('\n\n', local!, remote!);
      expect(result.clean).toBe(false);
      if (!result.clean) {
        expect(result.hunks).toEqual([{ base: '', local: local!.slice(2), remote: remote!.slice(2) }]);
        const select = (side: 'local' | 'remote') => result.parts.map(part =>
          typeof part === 'string' ? part : result.hunks[part.hunk]![side]).join('');
        expect(select('local')).toBe(local);
        expect(select('remote')).toBe(remote);
      }
    }
  });

  it('blank-line regression: returns full snapshots when pure-blank row endings differ', () => {
    const base = '\n\n';
    const local = 'A\r\n\n';
    const remote = '\nB\n';
    const result = mergeMarkdown(base, local, remote);

    expect(result.clean).toBe(false);
    if (!result.clean) {
      expect(result.hunks).toEqual([{ base, local, remote }]);
      expect(result.parts).toEqual([{ hunk: 0 }]);
    }
  });

  it('blank-line regression: keeps trivial pure-blank fast paths clean', () => {
    const base = '\n\n\n';
    const changed = 'A\n\n\n';

    expect(mergeMarkdown(base, changed, base)).toEqual({ clean: true, text: changed });
    expect(mergeMarkdown(base, base, changed)).toEqual({ clean: true, text: changed });
    expect(mergeMarkdown(base, changed, changed)).toEqual({ clean: true, text: changed });
  });

  it('does not apply blank-row positional handling to repeated nonblank text', () => {
    const base = 'anchor\nsame\nsame\n';
    const local = 'anchor\r\nsame\nsame\n';
    const remote = 'anchor\nsame\nREMOTE\n';

    expect(mergeMarkdown(base, local, remote))
      .toEqual({ clean: true, text: 'anchor\r\nsame\nREMOTE\n' });
  });

  it('returns base/local/remote hunk text and a separate UI preview for conflicting edits', () => {
    const result = mergeMarkdown('title\nold\nend\n', 'title\nlocal\nend\n', 'title\nremote\nend\n');
    expect(result.clean).toBe(false);
    if (result.clean) return;

    expect(result.hunks).toEqual([{ base: 'old\n', local: 'local\n', remote: 'remote\n' }]);
    expect(result.preview).toContain('<<<<<<< LOCAL\nlocal\n||||||| BASE\nold\n=======\nremote\n>>>>>>> REMOTE\n');
    expect(result.preview).not.toBe('title\nlocal\nend\n');
  });

  it('reports conflicting delete-versus-edit and same-position insertions', () => {
    const deleteEdit = mergeMarkdown('keep\nremove\n', 'keep\n', 'keep\nchanged\n');
    expect(deleteEdit.clean).toBe(false);
    if (!deleteEdit.clean) {
      expect(deleteEdit.hunks).toEqual([{ base: 'remove\n', local: '', remote: 'changed\n' }]);
    }

    const insertion = mergeMarkdown('start\nend\n', 'start\nlocal\nend\n', 'start\nremote\nend\n');
    expect(insertion.clean).toBe(false);

    const insertionAtDeleteBoundary = mergeMarkdown('A\nB\nC\n', 'A\nX\nB\nC\n', 'A\nC\n');
    expect(insertionAtDeleteBoundary.clean).toBe(false);
  });

  it('does not normalize line endings or invent a final newline in clean results', () => {
    expect(mergeMarkdown('a\r\nb\r\n', 'A\r\nb\r\n', 'a\r\nB\r\n'))
      .toEqual({ clean: true, text: 'A\r\nB\r\n' });
    expect(mergeMarkdown('a\nb', 'A\nb', 'a\nB'))
      .toEqual({ clean: true, text: 'A\nB' });
  });

  it('rejects oversized lines and excessive diff complexity', () => {
    expect(() => mergeMarkdown('', 'x'.repeat(128 * 1024 + 1), 'other'))
      .toThrow(/line exceeds/i);

    const lines = (prefix: string) => Array.from({ length: 2_100 }, (_, index) => `${prefix}${index}\n`).join('');
    expect(() => mergeMarkdown(lines('base'), lines('local'), lines('remote')))
      .toThrow(/complexity limit/i);
  });
});

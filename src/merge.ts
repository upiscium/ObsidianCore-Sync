import { diffPatch } from 'node-diff3';
import type { MergeHunk, MergeResult } from './contracts';

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_LINE_LENGTH = 128 * 1024;
const MAX_LINE_COUNT = 20_000;
const MAX_DIFF_WORK = 8_000_000;

type MergeSide = 'local' | 'remote';

interface DiffEdit {
  /** Start and deletion length are measured in the original/base lines. */
  start: number;
  deleteCount: number;
  insert: string[];
  sides: Set<MergeSide>;
}

interface DiffPatchChunk {
  buffer1: { offset: number; length: number };
  buffer2: { chunk: string[] };
}

interface LogicalRow {
  text: string;
  terminator: string;
}

interface PrecomputedEdits {
  local: DiffEdit[];
  remote: DiffEdit[];
}

interface MergeAction {
  start: number;
  end: number;
  edit?: DiffEdit;
  conflictEdits?: DiffEdit[];
}

/**
 * Split without normalizing line endings or manufacturing an extra final line.
 * Keeping each terminator on its line lets diff3 preserve CRLF/LF and the
 * distinction between a final newline and no final newline.
 */
function splitLines(text: string): string[] {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Markdown input exceeds the ${MAX_TEXT_LENGTH}-character merge limit.`);
  }

  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== '\n' && char !== '\r') {
      index++;
      continue;
    }

    if (char === '\r' && text[index + 1] === '\n') index += 2;
    else index++;

    if (index - start > MAX_LINE_LENGTH) {
      throw new RangeError(`A Markdown line exceeds the ${MAX_LINE_LENGTH}-character merge limit.`);
    }
    lines.push(text.slice(start, index));
    if (lines.length > MAX_LINE_COUNT) {
      throw new RangeError(`Markdown input exceeds the ${MAX_LINE_COUNT}-line merge limit.`);
    }
    start = index;
  }

  if (start < text.length) {
    if (text.length - start > MAX_LINE_LENGTH) {
      throw new RangeError(`A Markdown line exceeds the ${MAX_LINE_LENGTH}-character merge limit.`);
    }
    lines.push(text.slice(start));
    if (lines.length > MAX_LINE_COUNT) {
      throw new RangeError(`Markdown input exceeds the ${MAX_LINE_COUNT}-line merge limit.`);
    }
  }
  return lines;
}

function preferredLineEnding(...texts: string[]): string {
  for (const text of texts) {
    const match = text.match(/\r\n|\n|\r/);
    if (match) return match[0];
  }
  return '\n';
}

function endsInLineEnding(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r');
}

function appendConflictPreview(output: string, hunk: MergeHunk, eol: string): string {
  if (output.length > 0 && !endsInLineEnding(output)) output += eol;
  output += `<<<<<<< LOCAL${eol}`;
  output += hunk.local;
  if (hunk.local.length > 0 && !endsInLineEnding(hunk.local)) output += eol;
  output += `||||||| BASE${eol}`;
  output += hunk.base;
  if (hunk.base.length > 0 && !endsInLineEnding(hunk.base)) output += eol;
  output += `=======${eol}`;
  output += hunk.remote;
  if (hunk.remote.length > 0 && !endsInLineEnding(hunk.remote)) output += eol;
  output += `>>>>>>> REMOTE${eol}`;
  return output;
}

function wholeFileConflict(base: string, local: string, remote: string, eol: string): MergeResult {
  const hunk: MergeHunk = { base, local, remote };
  return {
    clean: false,
    hunks: [hunk],
    preview: appendConflictPreview('', hunk, eol),
    parts: [{ hunk: 0 }],
  };
}

function isPureBlankBase(text: string): boolean {
  return text.length > 0 && !/[^\r\n]/.test(text);
}

function logicalRows(lines: string[], text: string): LogicalRow[] {
  const rows = lines.map((line): LogicalRow => {
    let terminator = '';
    if (line.endsWith('\r\n')) terminator = '\r\n';
    else if (line.endsWith('\r') || line.endsWith('\n')) terminator = line.slice(-1);
    return { text: line, terminator };
  });

  // splitLines intentionally omits the virtual row after a final line ending.
  // It is a logical blank row here, but its empty text adds no bytes on join.
  if (text.length === 0 || endsInLineEnding(text)) rows.push({ text: '', terminator: '' });
  return rows;
}

function sameRowLayout(base: LogicalRow[], changed: LogicalRow[]): boolean {
  return base.length === changed.length &&
    base.every((row, index) => row.terminator === changed[index]?.terminator);
}

function positionalReplacementEdits(base: LogicalRow[], changed: LogicalRow[], side: MergeSide): DiffEdit[] {
  const edits: DiffEdit[] = [];
  for (let index = 0; index < base.length; index++) {
    const baseRow = base[index];
    const changedRow = changed[index];
    if (!baseRow || !changedRow) throw new Error('Logical row layouts changed after validation.');
    if (baseRow.text === changedRow.text) continue;
    edits.push({
      start: index,
      deleteCount: 1,
      insert: [changedRow.text],
      sides: new Set([side]),
    });
  }
  return edits;
}

function editsFromPatch(base: string[], changed: string[], side: MergeSide): DiffEdit[] {
  const patch = diffPatch(base, changed) as DiffPatchChunk[];
  return patch.map((part) => ({
    start: part.buffer1.offset,
    deleteCount: part.buffer1.length,
    insert: part.buffer2.chunk,
    sides: new Set([side]),
  }));
}

function sameEdit(left: DiffEdit, right: DiffEdit): boolean {
  return left.start === right.start &&
    left.deleteCount === right.deleteCount &&
    left.insert.length === right.insert.length &&
    left.insert.every((line, index) => line === right.insert[index]);
}

function editKey(edit: DiffEdit): string {
  return `${edit.start}:${edit.deleteCount}`;
}

function editOrder(left: DiffEdit, right: DiffEdit): number {
  return left.start - right.start || left.deleteCount - right.deleteCount;
}

/**
 * Insertions at a replacement/deletion boundary are intentionally treated as
 * ambiguous too. Adjacent non-empty base spans remain disjoint; this avoids
 * position-based guesses when one side has inserted or deleted lines.
 */
function editsConflict(left: DiffEdit, right: DiffEdit): boolean {
  const leftEnd = left.start + left.deleteCount;
  const rightEnd = right.start + right.deleteCount;
  if (left.deleteCount === 0 && right.deleteCount === 0) return left.start === right.start;
  if (left.deleteCount === 0) return left.start >= right.start && left.start <= rightEnd;
  if (right.deleteCount === 0) return right.start >= left.start && right.start <= leftEnd;
  return left.start < rightEnd && right.start < leftEnd;
}

function renderSideRange(base: string[], start: number, end: number, edits: DiffEdit[], side: MergeSide): string {
  const sideEdits = edits
    .filter((edit) => edit.sides.has(side))
    .sort(editOrder);
  let rendered = '';
  let cursor = start;
  for (const edit of sideEdits) {
    if (edit.start < cursor || edit.start + edit.deleteCount > end) {
      throw new Error('node-diff3 produced overlapping or out-of-range base patches.');
    }
    rendered += base.slice(cursor, edit.start).join('');
    rendered += edit.insert.join('');
    cursor = edit.start + edit.deleteCount;
  }
  return rendered + base.slice(cursor, end).join('');
}

function mergeEdits(
  base: string[],
  local: string[],
  remote: string[],
  eol: string,
  precomputedEdits?: PrecomputedEdits,
): MergeResult {
  const localEdits = (precomputedEdits?.local ?? editsFromPatch(base, local, 'local')).sort(editOrder);
  const remotePatchEdits = (precomputedEdits?.remote ?? editsFromPatch(base, remote, 'remote')).sort(editOrder);
  const uniqueEdits = [...localEdits];
  const remoteEdits: DiffEdit[] = [];
  const localBySpan = new Map<string, DiffEdit[]>();
  for (const edit of localEdits) {
    const key = editKey(edit);
    const bucket = localBySpan.get(key) ?? [];
    bucket.push(edit);
    localBySpan.set(key, bucket);
  }

  // Coalesce byte-for-byte identical edits so matching insertions/deletions
  // are applied once, while retaining which side(s) made each edit.
  for (const remoteEdit of remotePatchEdits) {
    const duplicate = localBySpan.get(editKey(remoteEdit))?.find((localEdit) => sameEdit(localEdit, remoteEdit));
    if (duplicate) {
      duplicate.sides.add('remote');
      remoteEdits.push(duplicate);
    } else {
      uniqueEdits.push(remoteEdit);
      remoteEdits.push(remoteEdit);
    }
  }

  const parents = new Map<DiffEdit, DiffEdit>(uniqueEdits.map((edit): [DiffEdit, DiffEdit] => [edit, edit]));
  const findRoot = (edit: DiffEdit): DiffEdit => {
    let root = edit;
    while (parents.get(root) !== root) root = parents.get(root)!;
    let current = edit;
    while (parents.get(current) !== root) {
      const next = parents.get(current)!;
      parents.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: DiffEdit, right: DiffEdit): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  // Both patch lists are ordered in base coordinates. The sweep only compares
  // edits whose original spans can intersect, including insertion boundaries.
  const conflictParticipants = new Set<DiffEdit>();
  let firstPossibleRemote = 0;
  for (const localEdit of localEdits) {
    const localEnd = localEdit.start + localEdit.deleteCount;
    while (firstPossibleRemote < remoteEdits.length) {
      const firstRemote = remoteEdits[firstPossibleRemote];
      if (!firstRemote || firstRemote.start + firstRemote.deleteCount >= localEdit.start) break;
      firstPossibleRemote++;
    }
    for (let index = firstPossibleRemote; index < remoteEdits.length; index++) {
      const remoteEdit = remoteEdits[index];
      if (!remoteEdit) continue;
      if (remoteEdit.start > localEnd) break;
      if (remoteEdit === localEdit || !editsConflict(localEdit, remoteEdit)) continue;
      union(localEdit, remoteEdit);
      conflictParticipants.add(localEdit);
      conflictParticipants.add(remoteEdit);
    }
  }

  const conflictRoots = new Set([...conflictParticipants].map(findRoot));
  const conflictGroups = new Map<DiffEdit, DiffEdit[]>();
  const conflictedEdits = new Set<DiffEdit>();
  for (const edit of uniqueEdits) {
    const root = findRoot(edit);
    if (!conflictRoots.has(root)) continue;
    const group = conflictGroups.get(root) ?? [];
    group.push(edit);
    conflictGroups.set(root, group);
    conflictedEdits.add(edit);
  }

  const actions: MergeAction[] = [];
  for (const edit of uniqueEdits) {
    if (!conflictedEdits.has(edit)) {
      actions.push({ start: edit.start, end: edit.start + edit.deleteCount, edit });
    }
  }
  for (const group of conflictGroups.values()) {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const edit of group) {
      start = Math.min(start, edit.start);
      end = Math.max(end, edit.start + edit.deleteCount);
    }
    actions.push({ start, end, conflictEdits: group });
  }
  actions.sort((left, right) => left.start - right.start || left.end - right.end);

  const hunks: MergeHunk[] = [];
  const parts: (string | { hunk: number })[] = [];
  let cleanText = '';
  let preview = '';
  let cursor = 0;
  for (const action of actions) {
    if (action.start < cursor) {
      throw new Error('node-diff3 produced overlapping merge actions outside a conflict hunk.');
    }
    const unchanged = base.slice(cursor, action.start).join('');
    parts.push(unchanged);
    cleanText += unchanged;
    preview += unchanged;

    if (action.conflictEdits) {
      const hunk: MergeHunk = {
        base: base.slice(action.start, action.end).join(''),
        local: renderSideRange(base, action.start, action.end, action.conflictEdits, 'local'),
        remote: renderSideRange(base, action.start, action.end, action.conflictEdits, 'remote'),
      };
      parts.push({ hunk: hunks.length });
      hunks.push(hunk);
      preview = appendConflictPreview(preview, hunk, eol);
    } else if (action.edit) {
      const inserted = action.edit.insert.join('');
      parts.push(inserted);
      cleanText += inserted;
      preview += inserted;
    }
    cursor = action.end;
  }

  const tail = base.slice(cursor).join('');
  parts.push(tail);
  cleanText += tail;
  preview += tail;
  return hunks.length === 0 ? { clean: true, text: cleanText } : { clean: false, hunks, preview, parts };
}

/**
 * Three-way merge Markdown text. Conflict markers are placed only in the
 * returned preview; callers must use `text` only for clean results.
 */
export function mergeMarkdown(base: string, local: string, remote: string): MergeResult {
  if (typeof base !== 'string' || typeof local !== 'string' || typeof remote !== 'string') {
    throw new TypeError('Markdown merge inputs must all be strings.');
  }

  // Validate limits even for otherwise-identical inputs so a single oversized
  // line cannot evade the defensive bounds.
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);

  if (local === remote) return { clean: true, text: local };
  if (local === base) return { clean: true, text: remote };
  if (remote === base) return { clean: true, text: local };

  const pureBlankBase = isPureBlankBase(base);
  const baseRows = pureBlankBase ? logicalRows(baseLines, base) : null;
  const localRows = pureBlankBase ? logicalRows(localLines, local) : null;
  const remoteRows = pureBlankBase ? logicalRows(remoteLines, remote) : null;

  const baseSize = Math.max(baseLines.length, baseRows?.length ?? 1);
  const localSize = Math.max(localLines.length, localRows?.length ?? 1);
  const remoteSize = Math.max(remoteLines.length, remoteRows?.length ?? 1);
  const localWork = baseSize * localSize;
  const remoteWork = baseSize * remoteSize;
  if (localWork + remoteWork > MAX_DIFF_WORK) {
    throw new RangeError('Markdown merge exceeds the safe diff complexity limit.');
  }

  const eol = preferredLineEnding(base, local, remote);
  if (baseRows && localRows && remoteRows) {
    if (!sameRowLayout(baseRows, localRows) || !sameRowLayout(baseRows, remoteRows)) {
      return wholeFileConflict(base, local, remote, eol);
    }

    const baseRowText = baseRows.map((row) => row.text);
    const localRowText = localRows.map((row) => row.text);
    const remoteRowText = remoteRows.map((row) => row.text);
    return mergeEdits(baseRowText, localRowText, remoteRowText, eol, {
      local: positionalReplacementEdits(baseRows, localRows, 'local'),
      remote: positionalReplacementEdits(baseRows, remoteRows, 'remote'),
    });
  }

  return mergeEdits(baseLines, localLines, remoteLines, eol);
}

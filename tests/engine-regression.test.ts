import { describe, expect, it } from 'vitest';
import { makeEngine, makePolicy, utf8 } from './helpers';

describe('review and race regressions', () => {
  it('validates uppercase JSON settings extensions', async () => {
    const path = '.obsidian/app.JSON';
    const fixture = makeEngine({ policy: makePolicy([], [path]) });
    fixture.local.seed(path, utf8('{ invalid json'));
    await fixture.engine.initialize();
    const report = await fixture.engine.sync();
    expect(report.errors).toHaveLength(1);
    expect(await fixture.remote.read(path)).toBeNull();
  });

  it.each(['__proto__', 'constructor', 'toString'])('normalizes ordinary state maps before syncing %s', async path => {
    const fixture = makeEngine();
    const originalLoad = fixture.store.load.bind(fixture.store);
    fixture.store.load = async endpoint => {
      const state = await originalLoad(endpoint);
      state.bases = {};
      state.conflicts = {};
      state.pending = {};
      state.validators = {};
      return state;
    };
    fixture.local.seed(path, utf8('data'));
    await fixture.engine.initialize();
    expect((await fixture.engine.sync()).errors).toEqual([]);
    expect(Object.hasOwn(fixture.engine.state.bases, path)).toBe(true);
    expect((await fixture.remote.read(path))?.data).toEqual(utf8('data'));
  });

  it('reuses an unchanged strong listed validator without downloading or rewriting state', async () => {
    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('unchanged'));
    await fixture.engine.initialize();
    await fixture.engine.sync();
    let reads = 0;
    fixture.remote.beforeRead = () => { reads++; };
    const saves = fixture.store.saveCalls;
    expect((await fixture.engine.sync()).errors).toEqual([]);
    expect(reads).toBe(0);
    expect(fixture.store.saveCalls).toBe(saves);
  });

  it.each(['weak', 'different', 'missing'])('does not reuse a %s listed validator', async kind => {
    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('unchanged'));
    await fixture.engine.initialize();
    await fixture.engine.sync();
    const list = fixture.remote.list.bind(fixture.remote);
    fixture.remote.list = async prefix => (await list(prefix)).map(entry => ({ ...entry,
      etag: kind === 'weak' ? `W/${entry.etag}` : kind === 'different' ? '"different"' : undefined,
    }));
    let reads = 0;
    fixture.remote.beforeRead = () => { reads++; };
    expect((await fixture.engine.sync()).errors).toEqual([]);
    expect(reads).toBeGreaterThan(0);
  });

  it('reconciles a definite failed conditional write on the next pass rather than inventing a partial-commit conflict', async () => {
    const fixture = makeEngine();
    fixture.local.seed('note.md', utf8('first\nsecond\n'));
    await fixture.engine.initialize();
    await fixture.engine.sync();
    fixture.local.seed('note.md', utf8('FIRST\nsecond\n'));
    fixture.remote.beforePut = () => { fixture.remote.forcePut('note.md', utf8('first\nSECOND\n')); };
    expect((await fixture.engine.sync()).errors).toHaveLength(1);
    expect(Object.hasOwn(fixture.engine.state.pending, 'note.md')).toBe(false);
    const retried = await fixture.engine.sync();
    expect(retried.errors).toEqual([]);
    expect(retried.conflicts).toEqual([]);
    expect(await fixture.local.read('note.md')).toEqual(utf8('FIRST\nSECOND\n'));
  });
});

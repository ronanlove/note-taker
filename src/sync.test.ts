import { describe, expect, it } from 'vitest';
import { conflictPath, isNotePath, newNote, numbered, type Note } from './notes';
import { gitBlobSha } from './sha1';
import type { LocalStore } from './store';
import { StaleHeadError, sync, type Change, type Remote } from './sync';

/** In-memory stand-in for a GitHub repo. */
class FakeRemote implements Remote {
  private commits = new Map<string, Map<string, string>>();
  private blobs = new Map<string, string>();
  current: string | null = null;
  commitCount = 0;
  /** Runs inside commit(), before the head check: simulates another device or the user acting mid-push. */
  beforeCommit?: () => Promise<void> | void;

  async head() {
    return this.current;
  }
  async list(head: string) {
    return [...this.commits.get(head)!].map(([path, content]) => ({ path, sha: gitBlobSha(content) }));
  }
  async read(sha: string) {
    return this.blobs.get(sha)!;
  }
  async commit(parent: string | null, changes: Change[]) {
    const hook = this.beforeCommit;
    this.beforeCommit = undefined;
    await hook?.();
    if (parent !== this.current) throw new StaleHeadError();
    const files = new Map(parent ? this.commits.get(parent) : []);
    for (const { path, content } of changes) {
      if (content === null) files.delete(path);
      else {
        files.set(path, content);
        this.blobs.set(gitBlobSha(content), content);
      }
    }
    const id = `c${++this.commitCount}`;
    this.commits.set(id, files);
    this.current = id;
    return id;
  }
  /** What the remote has right now, as path -> content. */
  files() {
    return Object.fromEntries(this.current ? this.commits.get(this.current)! : []);
  }
  /** Another device pushing directly. */
  async edit(path: string, content: string | null) {
    await this.commit(this.current, [{ path, content }]);
  }
}

function memoryStore() {
  const notes = new Map<string, Note>();
  let head: string | null = null;
  const store: LocalStore = {
    list: async () => [...notes.values()].map(({ content: _, ...info }) => info),
    get: async (path) => notes.get(path),
    put: async (note) => void notes.set(note.path, { ...note }),
    remove: async (path) => void notes.delete(path),
    getHead: async () => head,
    setHead: async (sha) => void (head = sha),
  };
  /** Visible notes as path -> content. */
  const contents = () => Object.fromEntries([...notes.values()].filter((n) => !n.deleted).map((n) => [n.path, n.content]));
  return { store, notes, contents };
}

const now = new Date(2026, 9, 29, 14, 32);

/** A local edit, the way the editor makes one. */
async function write(store: LocalStore, path: string, content: string) {
  const cur = await store.get(path);
  await store.put(cur ? { ...cur, content, dirty: true } : newNote(path, content));
}

async function remove(store: LocalStore, path: string) {
  const cur = (await store.get(path))!;
  if (cur.sha) await store.put({ ...cur, deleted: true, dirty: true });
  else await store.remove(path);
}

describe('gitBlobSha', () => {
  it('matches git hash-object', () => {
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(gitBlobSha('x'.repeat(1000))).toBe('14c7dfdd4258dec5c0e9d2e919bd249bd674be1f');
    expect(gitBlobSha('héllo ✍\n')).toBe('ef988752051a73dd373dff33aaae51613d1da50f');
  });
});

describe('paths', () => {
  it('only manages note files outside dot-folders', () => {
    expect(isNotePath('inbox/a.md')).toBe(true);
    expect(isNotePath('inbox/a.svg')).toBe(true);
    expect(isNotePath('classes/bio/.keep')).toBe(true);
    expect(isNotePath('README.md')).toBe(true);
    expect(isNotePath('.github/workflows/x.md')).toBe(false);
    expect(isNotePath('inbox/photo.png')).toBe(false);
    expect(isNotePath('inbox/.DS_Store')).toBe(false);
  });

  it('builds numbered and conflict names', () => {
    expect(numbered('inbox/a.md', 2)).toBe('inbox/a 2.md');
    expect(conflictPath('inbox/a.svg', now)).toBe('inbox/a (conflict 2026-10-29 1432).svg');
  });
});

describe('sync', () => {
  it('pushes new notes into an empty repo and marks them clean', async () => {
    const remote = new FakeRemote();
    const { store, notes } = memoryStore();
    await write(store, 'inbox/a.md', 'hello');
    const result = await sync(store, remote, now);
    expect(result.pushed).toBe(1);
    expect(remote.files()).toEqual({ 'inbox/a.md': 'hello' });
    expect(notes.get('inbox/a.md')).toMatchObject({ dirty: false, sha: gitBlobSha('hello') });
    expect(await store.getHead()).toBe(remote.current);
  });

  it('does nothing when already up to date', async () => {
    const remote = new FakeRemote();
    const { store } = memoryStore();
    await write(store, 'inbox/a.md', 'hello');
    await sync(store, remote, now);
    const result = await sync(store, remote, now);
    expect(result).toEqual({ changed: [], conflicts: [], pushed: 0 });
    expect(remote.commitCount).toBe(1);
  });

  it('pulls new and edited notes from another device', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await remote.edit('inbox/a.md', 'v1');
    await sync(store, remote, now);
    expect(contents()).toEqual({ 'inbox/a.md': 'v1' });

    await remote.edit('inbox/a.md', 'v2');
    await remote.edit('classes/b.svg', '<svg/>');
    const result = await sync(store, remote, now);
    expect(contents()).toEqual({ 'inbox/a.md': 'v2', 'classes/b.svg': '<svg/>' });
    expect(result.changed.sort()).toEqual(['classes/b.svg', 'inbox/a.md']);
  });

  it('ignores files that are not notes', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await remote.edit('.github/workflows/ci.yml', 'x');
    await remote.edit('photo.png', 'x');
    await sync(store, remote, now);
    expect(contents()).toEqual({});
  });

  it('keeps both versions when a note is edited on two devices', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await remote.edit('inbox/a.md', 'base');
    await sync(store, remote, now);

    await remote.edit('inbox/a.md', 'theirs');
    await write(store, 'inbox/a.md', 'ours');
    const result = await sync(store, remote, now);

    const copy = 'inbox/a (conflict 2026-10-29 1432).md';
    expect(result.conflicts).toEqual([{ path: 'inbox/a.md', copy }]);
    expect(contents()).toEqual({ 'inbox/a.md': 'theirs', [copy]: 'ours' });
    expect(remote.files()).toEqual({ 'inbox/a.md': 'theirs', [copy]: 'ours' });
  });

  it('treats identical edits on both sides as no conflict', async () => {
    const remote = new FakeRemote();
    const { store, notes } = memoryStore();
    await remote.edit('inbox/a.md', 'base');
    await sync(store, remote, now);
    await remote.edit('inbox/a.md', 'same');
    await write(store, 'inbox/a.md', 'same');
    const result = await sync(store, remote, now);
    expect(result.conflicts).toEqual([]);
    expect(notes.get('inbox/a.md')).toMatchObject({ content: 'same', dirty: false });
  });

  it('applies deletions in both directions', async () => {
    const remote = new FakeRemote();
    const { store, contents, notes } = memoryStore();
    await remote.edit('a.md', 'a');
    await remote.edit('b.md', 'b');
    await sync(store, remote, now);

    await remote.edit('a.md', null);
    await remove(store, 'b.md');
    await sync(store, remote, now);
    expect(contents()).toEqual({});
    expect(notes.size).toBe(0);
    expect(remote.files()).toEqual({});
  });

  it('keeps a note edited here but deleted elsewhere', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await remote.edit('a.md', 'v1');
    await sync(store, remote, now);
    await remote.edit('a.md', null);
    await write(store, 'a.md', 'v2');
    await sync(store, remote, now);
    expect(contents()).toEqual({ 'a.md': 'v2' });
    expect(remote.files()).toEqual({ 'a.md': 'v2' });
  });

  it('brings back a note deleted here but edited elsewhere', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await remote.edit('a.md', 'v1');
    await sync(store, remote, now);
    await remote.edit('a.md', 'v2');
    await remove(store, 'a.md');
    await sync(store, remote, now);
    expect(contents()).toEqual({ 'a.md': 'v2' });
    expect(remote.files()).toEqual({ 'a.md': 'v2' });
  });

  it('retries when another device pushes mid-sync', async () => {
    const remote = new FakeRemote();
    const { store, contents } = memoryStore();
    await write(store, 'mine.md', 'mine');
    remote.beforeCommit = () => remote.edit('theirs.md', 'theirs');
    await sync(store, remote, now);
    expect(remote.files()).toEqual({ 'mine.md': 'mine', 'theirs.md': 'theirs' });
    expect(contents()).toEqual({ 'mine.md': 'mine', 'theirs.md': 'theirs' });
  });

  it('keeps edits made while a push is in flight', async () => {
    const remote = new FakeRemote();
    const { store, notes } = memoryStore();
    await write(store, 'a.md', 'v1');
    remote.beforeCommit = () => write(store, 'a.md', 'v2');
    await sync(store, remote, now);
    expect(remote.files()).toEqual({ 'a.md': 'v1' });
    expect(notes.get('a.md')).toMatchObject({ content: 'v2', dirty: true, sha: gitBlobSha('v1') });
    await sync(store, remote, now);
    expect(remote.files()).toEqual({ 'a.md': 'v2' });
    expect(notes.get('a.md')).toMatchObject({ dirty: false });
  });

  it('deletes remotely a new note deleted while its first push was in flight', async () => {
    const remote = new FakeRemote();
    const { store, notes } = memoryStore();
    await write(store, 'a.md', 'v1');
    remote.beforeCommit = () => remove(store, 'a.md');
    await sync(store, remote, now);
    expect(remote.files()).toEqual({ 'a.md': 'v1' });
    await sync(store, remote, now);
    expect(remote.files()).toEqual({});
    expect(notes.size).toBe(0);
  });

  it('converges two devices', async () => {
    const remote = new FakeRemote();
    const ipad = memoryStore();
    const laptop = memoryStore();
    await write(ipad.store, 'inbox/lecture.svg', '<svg>1</svg>');
    await write(laptop.store, 'ideas/thesis.md', '# Thesis');
    await sync(ipad.store, remote, now);
    await sync(laptop.store, remote, now);
    await sync(ipad.store, remote, now);
    await write(laptop.store, 'inbox/lecture.svg', '<svg>2</svg>');
    await remove(ipad.store, 'ideas/thesis.md');
    await sync(laptop.store, remote, now);
    await sync(ipad.store, remote, now);
    await sync(laptop.store, remote, now);
    const expected = { 'inbox/lecture.svg': '<svg>2</svg>' };
    expect(ipad.contents()).toEqual(expected);
    expect(laptop.contents()).toEqual(expected);
    expect(remote.files()).toEqual(expected);
  });
});

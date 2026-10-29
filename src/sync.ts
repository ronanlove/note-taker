import { fromBase64 } from './base64';
import { conflictPath, isBinary, isNotePath, type Note } from './notes';
import { gitBlobSha } from './sha1';
import { freePath, locked, type LocalStore } from './store';

export interface RemoteFile {
  path: string;
  sha: string;
}

/** A file to write, or delete when content is null. Binary files (see isBinary) are base64. */
export interface Change {
  path: string;
  content: string | null;
}

/** Thrown by Remote.commit when another device pushed first. */
export class StaleHeadError extends Error {}

/**
 * Where notes are synced to. GitHub implements it today; anything that can store versioned files
 * (an Iroh peer, a server at home) could implement it later without touching the sync logic.
 */
export interface Remote {
  /** Current commit id, or null when the remote has no commits yet. */
  head(): Promise<string | null>;
  list(head: string): Promise<RemoteFile[]>;
  /** A file's content: text, or base64 for binary files. */
  read(sha: string, binary: boolean): Promise<string>;
  /** Applies changes on top of parent and returns the new head. Throws StaleHeadError if parent is no longer the head. */
  commit(parent: string | null, changes: Change[], message: string): Promise<string>;
}

export interface SyncResult {
  /** Paths that sync added, replaced or removed on this device. */
  changed: string[];
  /** Notes edited on both sides: the remote version is now at path, and ours was kept at copy. */
  conflicts: { path: string; copy: string }[];
  pushed: number;
}

/** Pulls remote changes into the local store, then pushes local changes as a single commit. Nothing is ever silently dropped. */
export async function sync(store: LocalStore, remote: Remote, now = new Date()): Promise<SyncResult> {
  const result: SyncResult = { changed: [], conflicts: [], pushed: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await remote.head();
    if (head !== (await store.getHead())) await pull(store, remote, head, result, now);

    const dirty = (await store.list()).filter((n) => n.dirty);
    const pending = (await Promise.all(dirty.map((n) => store.get(n.path)))).filter((n) => n !== undefined);
    if (!pending.length) return result;
    let newHead: string;
    try {
      const changes = pending.map((n) => ({ path: n.path, content: n.deleted ? null : n.content }));
      newHead = await remote.commit(head, changes, message(pending));
    } catch (e) {
      if (e instanceof StaleHeadError) continue;
      throw e;
    }
    await markPushed(store, pending, newHead);
    result.pushed += pending.length;
    return result;
  }
  throw new Error('Another device kept syncing at the same time. Try again.');
}

async function pull(store: LocalStore, remote: Remote, head: string | null, result: SyncResult, now: Date) {
  const files = head ? (await remote.list(head)).filter((f) => isNotePath(f.path)) : [];
  const known = new Map((await store.list()).map((n) => [n.path, n.sha]));
  const toFetch = files.filter((f) => known.get(f.path) !== f.sha);

  await eachLimit(toFetch, 6, async ({ path, sha }) => {
    const content = await remote.read(sha, isBinary(path));
    await locked(async () => {
      const local = await store.get(path);
      if (local?.sha === sha) return;
      if (local?.dirty && !local.deleted && local.content !== content) {
        // Edited here and on another device: keep ours under a new name.
        const copy = await freePath(store, conflictPath(path, now));
        await store.put({ ...local, path: copy, sha: null });
        result.conflicts.push({ path, copy });
        result.changed.push(copy);
      }
      // A local deletion loses to a remote edit, so those edits come back instead of vanishing.
      await store.put({ path, content, sha, dirty: false, deleted: false, updated: now.getTime() });
      result.changed.push(path);
    });
  });

  const present = new Set(files.map((f) => f.path));
  await locked(async () => {
    for (const n of await store.list()) {
      if (n.sha === null || present.has(n.path)) continue;
      // Deleted on another device. If it was edited here, keep it and upload it again.
      const local = n.dirty && !n.deleted ? await store.get(n.path) : undefined;
      if (local) await store.put({ ...local, sha: null });
      else await store.remove(n.path);
      result.changed.push(n.path);
    }
    await store.setHead(head);
  });
}

async function markPushed(store: LocalStore, sent: Note[], head: string) {
  await locked(async () => {
    for (const n of sent) {
      const cur = await store.get(n.path);
      const sha = n.deleted ? null : blobSha(n.path, n.content);
      if (!cur) {
        // Deleted here while the push was in flight: delete it remotely next time.
        if (sha) await store.put({ ...n, sha, deleted: true, dirty: true });
      } else if (n.deleted && cur.deleted) {
        await store.remove(n.path);
      } else {
        // Anything edited while the push was in flight stays dirty for the next sync.
        const clean = !n.deleted && !cur.deleted && cur.content === n.content;
        await store.put({ ...cur, sha, dirty: !clean });
      }
    }
    await store.setHead(head);
  });
}

/** The git id of a file as stored on the device: binary files are hashed as their bytes, not their base64. */
export const blobSha = (path: string, content: string) => gitBlobSha(isBinary(path) ? fromBase64(content) : content);

function message(notes: Note[]): string {
  if (notes.length > 1) return `Update ${notes.length} notes`;
  const [n] = notes;
  return `${n.deleted ? 'Delete' : n.sha ? 'Update' : 'Add'} ${n.path}`;
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

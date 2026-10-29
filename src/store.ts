import { numbered, type Note } from './notes';

/** Everything about a note except its content, which can be large for handwriting. */
export type NoteInfo = Omit<Note, 'content'>;

/** Notes saved on this device. Every note lives here first; sync copies changes to and from the remote. */
export interface LocalStore {
  list(): Promise<NoteInfo[]>;
  get(path: string): Promise<Note | undefined>;
  put(note: Note): Promise<void>;
  remove(path: string): Promise<void>;
  /** Remote commit this device last synced with. */
  getHead(): Promise<string | null>;
  setHead(sha: string | null): Promise<void>;
}

/** IndexedDB with note info and content in separate object stores, so listing notes stays cheap. */
export function idbStore(): LocalStore {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('jot', 1);
    req.onupgradeneeded = () => {
      for (const name of ['info', 'content', 'state']) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T): Promise<T> {
    const t = (await db).transaction(stores, mode);
    const out = fn(t);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
    });
  }

  return {
    list: () =>
      run(['info'], 'readonly', (t) => t.objectStore('info').getAll()).then((req) => req.result as NoteInfo[]),
    async get(path) {
      const [info, content] = await run(['info', 'content'], 'readonly', (t) => [
        t.objectStore('info').get(path),
        t.objectStore('content').get(path),
      ]);
      return info.result ? { ...info.result, content: content.result ?? '' } : undefined;
    },
    put: ({ content, ...info }) =>
      run(['info', 'content'], 'readwrite', (t) => {
        t.objectStore('info').put(info, info.path);
        t.objectStore('content').put(content, info.path);
      }),
    remove: (path) =>
      run(['info', 'content'], 'readwrite', (t) => {
        t.objectStore('info').delete(path);
        t.objectStore('content').delete(path);
      }),
    getHead: () =>
      run(['state'], 'readonly', (t) => t.objectStore('state').get('head')).then((req) => req.result ?? null),
    setHead: (sha) =>
      run(['state'], 'readwrite', (t) => {
        t.objectStore('state').put(sha, 'head');
      }),
  };
}

let tail: Promise<unknown> = Promise.resolve();

/** Runs fn exclusively, so read-modify-write sequences from the editor and from sync never interleave. Don't nest calls. */
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.catch(() => {});
  return run;
}

/** path, or "path 2", "path 3"... whichever is not taken yet. */
export async function freePath(store: LocalStore, path: string): Promise<string> {
  let candidate = path;
  for (let n = 2; await store.get(candidate); n++) candidate = numbered(path, n);
  return candidate;
}

export interface Note {
  /** Path inside the notes repo, e.g. "inbox/2026-10-29 1432.svg". */
  path: string;
  content: string;
  /** Git blob SHA of the version last seen on the remote; null if it has never been synced. */
  sha: string | null;
  /** Has local changes (or a deletion) that still need to be pushed. */
  dirty: boolean;
  /** Deleted on this device; the deletion is pushed on the next sync. */
  deleted: boolean;
  updated: number;
}

export type Kind = 'text' | 'ink';

export const INBOX = 'inbox';
/** Placeholder file that keeps an empty folder in git. */
export const KEEP = '.keep';
/** Photos and PDFs used by handwritten notes, named by their content so each is stored once. */
export const ATTACHMENTS = 'attachments';

export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** File name without its extension, shown as the note's title. */
export function title(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export const kindOf = (path: string): Kind => (extname(path).toLowerCase() === 'svg' ? 'ink' : 'text');

/** Binary files, kept as base64 text on the device. */
export const isBinary = (path: string) => /\.(pdf|png|jpe?g|webp|gif)$/i.test(path);

export const isAttachment = (path: string) => path.startsWith(`${ATTACHMENTS}/`);

/**
 * Files the app manages: Markdown, text and ink notes, folder placeholders, and the photos and PDFs in attachments/.
 * Dot-folders like .github are skipped.
 */
export function isNotePath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.pop()!;
  if (parts.some((p) => p.startsWith('.'))) return false;
  if (name === KEEP) return true;
  if (name.startsWith('.')) return false;
  if (isAttachment(path)) return parts.length === 1 && isBinary(name);
  return /\.(md|txt|svg)$/i.test(name);
}

export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** "a/b.md" -> "a/b 2.md" */
export function numbered(path: string, n: number): string {
  const ext = extname(path);
  const base = ext ? path.slice(0, -ext.length - 1) : path;
  return `${base} ${n}${ext ? '.' + ext : ''}`;
}

export function conflictPath(path: string, when: Date): string {
  const ext = extname(path);
  return join(dirname(path), `${title(path)} (conflict ${stamp(when)})${ext ? '.' + ext : ''}`);
}

export const newNote = (path: string, content: string): Note => ({
  path,
  content,
  sha: null,
  dirty: true,
  deleted: false,
  updated: Date.now(),
});

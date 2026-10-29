import './style.css';
import { GitHubRemote } from './github';
import { icon, type IconName } from './icons';
import { INK_COLORS, InkEditor } from './ink';
import { INBOX, KEEP, basename, conflictPath, dirname, extname, join, kindOf, newNote, stamp, title, type Kind } from './notes';
import { isConfigured, loadSettings, parseRepo, saveSettings, type Settings } from './settings';
import { freePath, idbStore, locked, type NoteInfo } from './store';
import { sync, type SyncResult } from './sync';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const store = idbStore();
let settings = loadSettings();

/** The note on screen. A new note is only stored once something is written in it. */
interface Session {
  path: string;
  kind: Kind;
  stored: boolean;
  /** Content as last loaded or saved, to tell our edits apart from changes sync made underneath. */
  loaded: string;
}
let session!: Session;
let saveTimer = 0;

let notes: NoteInfo[] = [];
let pending = false;
const expanded = new Set([INBOX]);

let phase: 'idle' | 'syncing' | 'offline' | 'error' = 'idle';
let syncError = '';
let lastSync: Date | null = null;

// ---------- Editing

const textarea = document.createElement('textarea');
textarea.className = 'text';
textarea.placeholder = 'Start typing…';
textarea.addEventListener('input', edited);
const ink = new InkEditor(() => {
  updateInkTools();
  edited();
});
$('#editor').append(textarea, ink.el);

function show(next: Session, content: string) {
  session = next;
  const isInk = next.kind === 'ink';
  textarea.hidden = isInk;
  ink.el.hidden = !isInk;
  $('#inktools').hidden = !isInk;
  if (isInk) ink.load(content);
  else textarea.value = content;
  expanded.add(dirname(next.path));
  renderHeader();
  updateInkTools();
  renderDrawer();
}

function edited() {
  pending = true;
  renderStatus();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 600);
}

async function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  await save();
}

async function save() {
  saveTimer = 0;
  const s = session;
  const content = s.kind === 'ink' ? ink.serialize() : textarea.value;
  const blank = s.kind === 'ink' ? ink.empty : !content.trim();
  if (content === s.loaded || (!s.stored && blank)) return refresh();
  const before = s.stored ? s.path : null;
  let forked = false;
  await locked(async () => {
    const cur = s.stored ? await store.get(s.path) : undefined;
    if (cur && !cur.dirty && cur.content !== s.loaded) {
      // Sync replaced this note while it was being edited: keep both versions.
      s.path = await freePath(store, conflictPath(s.path, new Date()));
      await store.put(newNote(s.path, content));
      forked = true;
    } else if (cur) {
      await store.put({ ...cur, content, dirty: true, deleted: false, updated: Date.now() });
    } else {
      if (!s.stored) s.path = await freePath(store, s.path);
      await store.put(newNote(s.path, content));
    }
    s.stored = true;
    s.loaded = content;
  });
  if (forked) toast(`This note changed on another device. Your edits were saved as “${title(s.path)}”.`);
  if (s.path !== before) {
    await refresh();
    if (s === session) renderHeader();
  }
  scheduleSync();
}

async function open(path: string) {
  await flush();
  const note = await store.get(path);
  if (!note || note.deleted) return;
  show({ path, kind: kindOf(path), stored: true, loaded: note.content }, note.content);
  closeDrawer();
}

async function startNew(kind: Kind, folder: string) {
  await flush();
  const path = await freePath(store, join(folder, `${stamp(new Date())}.${kind === 'ink' ? 'svg' : 'md'}`));
  show({ path, kind, stored: false, loaded: '' }, '');
  closeDrawer();
  if (kind === 'text') textarea.focus();
}

async function moveCurrent(rawName: string, folder: string) {
  const name = rawName.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!name || name.startsWith('.')) return toast('That name won’t work. Try another.');
  const s = session;
  const to = join(folder, `${name}.${extname(s.path)}`);
  if (to === s.path) return;
  const target = await store.get(to);
  if (target && !target.deleted) return toast('There’s already a note with that name there.');
  await flush();
  if (s.stored) {
    await locked(async () => {
      const cur = await store.get(s.path);
      if (!cur) return;
      // Reusing a just-deleted path updates that remote file instead of conflicting with it.
      await store.put({ ...newNote(to, cur.content), sha: target?.sha ?? null });
      if (cur.sha) await store.put({ ...cur, deleted: true, dirty: true });
      else await store.remove(cur.path);
    });
    scheduleSync();
  }
  s.path = to;
  expanded.add(folder);
  renderHeader();
  await refresh();
}

async function deleteCurrent() {
  const s = session;
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (s.stored) {
    await locked(async () => {
      const cur = await store.get(s.path);
      if (!cur) return;
      if (cur.sha) await store.put({ ...cur, deleted: true, dirty: true, updated: Date.now() });
      else await store.remove(cur.path);
    });
    scheduleSync();
  }
  await refresh();
  await startNew(s.kind, dirname(s.path));
}

async function newFolder() {
  const raw = prompt('New folder name (use / for subfolders, like classes/biology)');
  if (!raw) return;
  const folder = raw
    .split('/')
    .map((part) => part.trim().replace(/[\\:*?"<>|]/g, '-'))
    .filter(Boolean)
    .join('/');
  if (!folder || folder.split('/').some((part) => part.startsWith('.'))) return toast('That name won’t work. Try another.');
  const path = join(folder, KEEP);
  await locked(async () => {
    if (!(await store.get(path))) await store.put(newNote(path, ''));
  });
  expanded.add(folder);
  await refresh();
  scheduleSync();
}

// ---------- Sync

let syncing: Promise<void> | null = null;
let again = false;
let syncTimer = 0;

function scheduleSync(delay = 3000) {
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(syncNow, delay);
}

/** Runs a sync, or queues one more if a sync is already running. */
function syncNow(): Promise<void> {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        again = false;
        await runSync();
      } while (again);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function runSync() {
  clearTimeout(syncTimer);
  await flush();
  if (!isConfigured(settings)) return renderStatus();
  if (!navigator.onLine) {
    phase = 'offline';
    return renderStatus();
  }
  phase = 'syncing';
  renderStatus();
  try {
    const result = await sync(store, new GitHubRemote(settings));
    phase = 'idle';
    lastSync = new Date();
    await refresh();
    await reconcile(result);
  } catch (e) {
    syncError = e instanceof Error ? e.message : String(e);
    phase = !navigator.onLine || /failed to fetch|load failed|networkerror/i.test(syncError) ? 'offline' : 'error';
  }
  renderStatus();
}

/** Brings the open note up to date with whatever sync changed. */
async function reconcile({ conflicts }: SyncResult) {
  const s = session;
  if (!s.stored || saveTimer || ink.busy) return;
  const conflict = conflicts.find((c) => c.path === s.path);
  if (conflict) {
    toast(`This note was also edited on another device. Both versions were kept; you’re now on “${title(conflict.copy)}”.`);
    return open(conflict.copy);
  }
  const cur = await store.get(s.path);
  if (!cur || cur.deleted) {
    toast('This note was deleted on another device.');
    return startNew(s.kind, dirname(s.path));
  }
  if (cur.content !== s.loaded) show({ ...s, loaded: cur.content }, cur.content);
}

/** Points this device at a different repo: every note here is uploaded there on the next sync. */
async function relink() {
  await flush();
  await locked(async () => {
    for (const info of await store.list()) {
      const n = await store.get(info.path);
      if (!n) continue;
      if (n.deleted) await store.remove(n.path);
      else await store.put({ ...n, sha: null, dirty: true });
    }
    await store.setHead(null);
  });
  await refresh();
}

// ---------- Rendering

async function refresh() {
  const all = await store.list();
  notes = all.filter((n) => !n.deleted);
  pending = all.some((n) => n.dirty);
  renderDrawer();
  renderStatus();
}

function renderHeader() {
  const folder = dirname(session.path);
  $('#folder').textContent = folder ? `${folderLabel(folder)} / ` : '';
  $('#name').textContent = title(session.path);
}

function statusText(): [state: string, text: string] {
  if (!isConfigured(settings)) return ['local', 'Sync is off. Set up GitHub in settings.'];
  if (phase === 'syncing') return ['syncing', 'Syncing…'];
  if (phase === 'offline') return ['offline', 'Offline. Notes are saved on this device.'];
  if (phase === 'error') return ['error', `Sync failed: ${syncError}`];
  if (pending) return ['pending', 'Waiting to sync'];
  const at = lastSync?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return ['synced', at ? `Synced at ${at}` : 'Synced'];
}

function renderStatus() {
  const [state, text] = statusText();
  const dot = $('#status');
  dot.dataset.state = state;
  dot.title = text;
  $('#sync-text').textContent = text;
}

const folderLabel = (folder: string) => (folder === INBOX ? 'Inbox' : folder || 'Top level');

function folders(): string[] {
  const set = new Set([INBOX, dirname(session.path)]);
  for (const n of notes) set.add(dirname(n.path));
  return [...set].sort((a, b) => (a === INBOX ? -1 : b === INBOX ? 1 : a.localeCompare(b)));
}

function renderDrawer() {
  const list = $('#folders');
  list.replaceChildren();
  for (const folder of folders()) {
    const items = notes
      .filter((n) => dirname(n.path) === folder && basename(n.path) !== KEEP)
      .sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }));
    const isOpen = expanded.has(folder);

    const toggle = el('button', 'folder-name', folderLabel(folder));
    toggle.append(el('span', 'count', String(items.length)));
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.onclick = () => {
      if (!expanded.delete(folder)) expanded.add(folder);
      renderDrawer();
    };
    const add = iconButton('plus', `New note in ${folderLabel(folder)}`);
    add.onclick = () => startNew(settings.capture, folder);
    const head = el('div', 'folder-head');
    head.append(toggle, add);

    const section = el('section');
    section.append(head);
    if (isOpen) {
      const ul = el('ul', 'notes');
      for (const n of items) {
        const b = el('button', 'note', title(n.path));
        if (kindOf(n.path) === 'ink') b.insertAdjacentHTML('afterbegin', icon('pen'));
        if (n.path === session.path) b.setAttribute('aria-current', 'true');
        b.onclick = () => open(n.path);
        const li = el('li');
        li.append(b);
        ul.append(li);
      }
      if (!items.length) ul.append(el('li', 'empty', 'No notes yet'));
      section.append(ul);
    }
    list.append(section);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function iconButton(name: IconName, label: string) {
  const b = el('button', 'icon');
  b.innerHTML = icon(name);
  b.setAttribute('aria-label', label);
  return b;
}

let toastTimer = 0;
function toast(message: string) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

// ---------- Ink tools

const COLOR_NAMES = ['Black', 'Blue', 'Red'];
const swatches = INK_COLORS.map((color, i) => {
  const b = el('button', 'swatch');
  b.style.setProperty('--c', `var(--ink-${i + 1})`);
  b.setAttribute('aria-label', `${COLOR_NAMES[i]} pen`);
  b.onclick = () => {
    ink.tool = 'pen';
    ink.color = color;
    updateInkTools();
  };
  return b;
});
$('#swatches').append(...swatches);
$('#eraser').onclick = () => {
  ink.tool = ink.tool === 'eraser' ? 'pen' : 'eraser';
  updateInkTools();
};
$('#undo').onclick = () => ink.undo();
$('#redo').onclick = () => ink.redo();

function updateInkTools() {
  swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(ink.tool === 'pen' && ink.color === INK_COLORS[i])));
  $('#eraser').setAttribute('aria-pressed', String(ink.tool === 'eraser'));
  $<HTMLButtonElement>('#undo').disabled = !ink.canUndo;
  $<HTMLButtonElement>('#redo').disabled = !ink.canRedo;
}

// ---------- Drawer and dialogs

function openDrawer() {
  renderDrawer();
  $('#drawer').classList.add('open');
  $('#drawer').inert = false;
  $('#scrim').hidden = false;
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').inert = true;
  $('#scrim').hidden = true;
}

const noteDialog = $<HTMLDialogElement>('#note-dialog');

function openNoteDialog() {
  $<HTMLInputElement>('#note-name').value = title(session.path);
  const select = $<HTMLSelectElement>('#note-folder');
  select.replaceChildren(...folders().map((f) => new Option(folderLabel(f), f)));
  select.value = dirname(session.path);
  noteDialog.returnValue = '';
  noteDialog.showModal();
}

noteDialog.addEventListener('close', () => {
  if (noteDialog.returnValue !== 'save') return;
  void moveCurrent($<HTMLInputElement>('#note-name').value, $<HTMLSelectElement>('#note-folder').value);
});
$('#note-cancel').onclick = () => noteDialog.close();
$('#note-delete').onclick = () => {
  noteDialog.close();
  if (confirm('Delete this note?')) void deleteCurrent();
};

const settingsDialog = $<HTMLDialogElement>('#settings-dialog');

function openSettings() {
  $<HTMLInputElement>('#s-repo').value = settings.owner ? `${settings.owner}/${settings.repo}` : '';
  $<HTMLInputElement>('#s-branch').value = settings.branch;
  $<HTMLInputElement>('#s-token').value = settings.token;
  $<HTMLSelectElement>('#s-capture').value = settings.capture;
  $('#s-msg').textContent = '';
  closeDrawer();
  settingsDialog.showModal();
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#s-msg');
  const repoInput = $<HTMLInputElement>('#s-repo').value;
  const repo = parseRepo(repoInput);
  if (repoInput.trim() && !repo) return void (msg.textContent = 'Enter the repository as username/repo.');
  const next: Settings = {
    owner: repo?.owner ?? '',
    repo: repo?.repo ?? '',
    branch: $<HTMLInputElement>('#s-branch').value.trim() || 'main',
    token: $<HTMLInputElement>('#s-token').value.trim(),
    capture: $<HTMLSelectElement>('#s-capture').value as Kind,
  };
  let warning: string | undefined;
  if (isConfigured(next)) {
    msg.textContent = 'Checking…';
    try {
      warning = await new GitHubRemote(next).check();
    } catch (err) {
      msg.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
  }
  const moved = next.owner !== settings.owner || next.repo !== settings.repo || next.branch !== settings.branch;
  settings = next;
  saveSettings(next);
  if (moved && isConfigured(next)) await relink();
  settingsDialog.close();
  if (warning) toast(warning);
  void syncNow();
});
$('#s-cancel').onclick = () => settingsDialog.close();

// ---------- Start

for (const b of document.querySelectorAll<HTMLElement>('[data-icon]')) b.innerHTML = icon(b.dataset.icon as IconName);
$('#menu').onclick = openDrawer;
$('#scrim').onclick = closeDrawer;
$('#title').onclick = openNoteDialog;
$('#new-ink').onclick = () => startNew('ink', dirname(session.path));
$('#new-text').onclick = () => startNew('text', dirname(session.path));
$('#new-folder').onclick = newFolder;
$('#open-settings').onclick = openSettings;
$('#status').onclick = () => {
  if (!isConfigured(settings)) return openSettings();
  toast(statusText()[1]);
  void syncNow();
};

document.addEventListener('keydown', (e) => {
  if (session.kind !== 'ink' || !(e.metaKey || e.ctrlKey) || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  e.preventDefault();
  if (key === 'y' || e.shiftKey) ink.redo();
  else ink.undo();
});
// iPadOS can suspend the app as soon as it is hidden, so save and sync right away.
document.addEventListener('visibilitychange', () => void syncNow());
window.addEventListener('pagehide', () => void flush());
window.addEventListener('online', () => void syncNow());
window.addEventListener('offline', () => {
  phase = 'offline';
  renderStatus();
});
setInterval(() => {
  if (document.visibilityState === 'visible') void syncNow();
}, 60_000);

async function start() {
  closeDrawer();
  // Quick capture: the app always opens on a fresh page in the inbox.
  await startNew(settings.capture, INBOX);
  await refresh();
  void syncNow();
  navigator.storage?.persist?.().catch(() => {});
}

void start();

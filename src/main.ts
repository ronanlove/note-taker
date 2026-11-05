import './style.css';
import { fromBase64, toBase64 } from './base64';
import { GitHubRemote } from './github';
import { icon, type IconName } from './icons';
import { InkEditor, displayColor, type Tool } from './ink';
import {
  ATTACHMENTS,
  INBOX,
  KEEP,
  basename,
  conflictPath,
  dirname,
  extname,
  isAttachment,
  join,
  kindOf,
  newNote,
  stamp,
  title,
  type Kind,
} from './notes';
import { isConfigured, loadSettings, loadTools, parseRepo, saveSettings, saveTools, type Settings } from './settings';
import { gitBlobSha } from './sha1';
import { freePath, idbStore, locked, type NoteInfo } from './store';
import { LINE_GAP, attachmentsIn, toSvg, type Paper } from './strokes';
import { sync, type SyncResult } from './sync';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const store = idbStore();
let settings = loadSettings();
const tools = loadTools();

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
textarea.addEventListener('input', noteEdited);
const ink = new InkEditor(tools, {
  changed(edited) {
    updateInkTools();
    if (edited) noteEdited();
  },
  file: readFile,
  problem: toast,
});
$('#editor').append(textarea, ink.el);

function show(next: Session, content: string) {
  const same = session?.path === next.path;
  session = next;
  const isInk = next.kind === 'ink';
  textarea.hidden = isInk;
  ink.el.hidden = !isInk;
  $('#inktools').hidden = !isInk;
  if (isInk) ink.load(content, same);
  else textarea.value = content;
  expanded.add(dirname(next.path));
  renderHeader();
  updateInkTools();
  renderDrawer();
}

function noteEdited() {
  pending = true;
  lastEdit = Date.now();
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
  // Edits wait for a quiet spell so writing isn't interrupted and the repo gets one commit per session, not per pause.
  scheduleSync(EDIT_SYNC_DELAY);
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
    let content = '';
    await locked(async () => {
      const cur = await store.get(s.path);
      if (!cur) return;
      content = cur.content;
      if (cur.sha) await store.put({ ...cur, deleted: true, dirty: true, updated: Date.now() });
      else await store.remove(cur.path);
    });
    await dropAttachments(content);
    scheduleSync();
  }
  await refresh();
  await startNew(s.kind, dirname(s.path));
}

/** Deletes the photos and PDF that only a just-deleted note used. */
async function dropAttachments(content: string) {
  const used = new Set(attachmentsIn(content));
  if (!used.size) return;
  for (const n of await store.list()) {
    if (n.deleted || kindOf(n.path) !== 'ink') continue;
    for (const a of attachmentsIn((await store.get(n.path))?.content ?? '')) used.delete(a);
  }
  await locked(async () => {
    for (const path of used) {
      const cur = await store.get(path);
      if (cur?.sha) await store.put({ ...cur, deleted: true, dirty: true });
      else if (cur) await store.remove(path);
    }
  });
}

/** A photo or PDF stored on this device, or null if it hasn't synced here yet. */
async function readFile(path: string) {
  const note = await store.get(path);
  return note && !note.deleted ? fromBase64(note.content) : null;
}

/** Stores a photo or PDF in attachments/, named by its content so the same file is only stored once. */
async function attach(bytes: Uint8Array, ext: string): Promise<string> {
  const path = join(ATTACHMENTS, `${gitBlobSha(bytes).slice(0, 16)}.${ext}`);
  await locked(async () => {
    const cur = await store.get(path);
    if (!cur || cur.deleted) await store.put({ ...newNote(path, toBase64(bytes)), sha: cur?.sha ?? null });
  });
  return path;
}

/** Photos are scaled to at most 2000 px and saved as JPEG. Small PNGs, like screenshots, stay PNG so text stays crisp. */
async function preparePhoto(file: Blob) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = bitmap;
  const scale = Math.min(1, 2000 / Math.max(width, height));
  if (file.type === 'image/png' && scale === 1 && file.size < 1_500_000) {
    bitmap.close();
    return { bytes: new Uint8Array(await file.arrayBuffer()), ext: 'png', width, height };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  // JPEG has no transparency, so see-through parts become white rather than black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('could not encode the image');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'jpg', width: canvas.width, height: canvas.height };
}

async function insertPhoto(file: Blob) {
  if (session.kind !== 'ink') return toast('Photos go on handwritten notes. Open one, then add the photo.');
  try {
    const photo = await preparePhoto(file);
    ink.insertPicture(await attach(photo.bytes, photo.ext), photo.width, photo.height);
  } catch {
    toast('That image couldn’t be added. Try a JPEG or PNG.');
  }
}

/** Starts a handwritten note on a PDF, named after it, in the current folder. */
async function importPdf(file: File) {
  // GitHub stores files up to 100 MB; base64 and the API's limits leave room for about half that.
  if (file.size > 50_000_000) return toast('That PDF is over 50 MB, too big to sync through GitHub.');
  await flush();
  closeDrawer();
  const src = await attach(new Uint8Array(await file.arrayBuffer()), 'pdf');
  const name = file.name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-').trim() || stamp(new Date());
  const path = await locked(async () => {
    const free = await freePath(store, join(dirname(session.path), `${name}.svg`));
    await store.put(newNote(free, toSvg({ paper: 'blank', pdf: src, items: [] }, 2 * LINE_GAP)));
    return free;
  });
  await refresh();
  scheduleSync();
  await open(path);
}

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

/** A PDF of the open handwritten note: the share sheet on iPad (Save to Files, AirDrop, Mail), a download elsewhere. */
async function exportCurrent() {
  if (session.kind !== 'ink') return;
  await flush();
  toast('Making the PDF…');
  try {
    const { exportPdf, paperSize } = await import('./export');
    const bytes = await exportPdf(title(session.path), ink.page(), readFile, paperSize(navigator.language));
    const file = new File([bytes.slice()], `${title(session.path)}.pdf`, { type: 'application/pdf' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) return share(file);
    const url = URL.createObjectURL(file);
    const a = el('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Downloaded ${file.name}`);
  } catch (e) {
    toast(`Couldn’t make the PDF: ${e instanceof Error ? e.message : e}`);
  }
}

async function share(file: File) {
  try {
    await navigator.share({ files: [file] });
    $('#toast').hidden = true;
  } catch (e) {
    // Safari only shares straight after a tap, and making the PDF can take longer than it allows: ask for another tap.
    if (e instanceof DOMException && e.name === 'NotAllowedError') toast('Your PDF is ready.', { label: 'Share', run: () => void share(file) });
    else if (!(e instanceof DOMException && e.name === 'AbortError')) toast('Sharing didn’t work. Try again.');
  }
}

async function newFolder() {
  const raw = prompt('New folder name (use / for subfolders, like classes/biology)');
  if (!raw) return;
  const folder = raw
    .split('/')
    .map((part) => part.trim().replace(/[\\:*?"<>|]/g, '-'))
    .filter(Boolean)
    .join('/');
  const parts = folder.split('/');
  if (!folder || parts.some((part) => part.startsWith('.')) || parts[0] === ATTACHMENTS) return toast('That name won’t work. Try another.');
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
/** How long to wait after the last edit before syncing. Leaving the app syncs right away regardless. */
const EDIT_SYNC_DELAY = 2 * 60_000;
let lastEdit = 0;

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
async function reconcile({ conflicts, changed }: SyncResult) {
  if (changed.some(isAttachment)) ink.reloadFiles();
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
  notes = all.filter((n) => !n.deleted && !isAttachment(n.path));
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
function toast(message: string, action?: { label: string; run: () => void }) {
  const t = $('#toast');
  t.replaceChildren(message);
  if (action) {
    const b = el('button', 'toast-action', action.label);
    b.onclick = () => {
      t.hidden = true;
      action.run();
    };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 5000);
}

// ---------- Ink tools

const toolButtons: [Tool, HTMLElement][] = [
  ['pen', $('#tool-pen')],
  ['highlighter', $('#tool-highlighter')],
  ['eraser', $('#tool-eraser')],
  ['lasso', $('#tool-lasso')],
];
for (const [tool, b] of toolButtons) b.onclick = () => pickTool(tool);

/** The colors and sizes on show: the highlighter's, or the pen's. */
const palette = () => (tools.tool === 'highlighter' ? tools.markers : tools.pens);

function pickTool(tool: Tool) {
  // Tapping the pen again switches between fountain pen and ballpoint.
  if (tool === 'pen' && tools.tool === 'pen') {
    tools.pen = tools.pen === 'fountain' ? 'ballpoint' : 'fountain';
    toast(tools.pen === 'fountain' ? 'Fountain pen: line width follows pressure' : 'Ballpoint pen: even line width');
  }
  ink.setTool(tool);
  toolsChanged();
}

function toolsChanged() {
  saveTools(tools);
  updateInkTools();
}

const swatches = [0, 1, 2].map((i) => {
  const wrap = el('span', 'swatch');
  const button = el('button');
  // Tapping the chosen color again opens a picker to change it.
  const picker = el('input');
  picker.type = 'color';
  picker.tabIndex = -1;
  picker.setAttribute('aria-label', 'Change this color');
  picker.oninput = () => {
    palette().colors[i] = picker.value;
    toolsChanged();
  };
  button.onclick = () => {
    if (tools.tool === 'lasso') return ink.recolor(tools.pens.colors[i]);
    palette().color = i;
    toolsChanged();
  };
  wrap.append(button, picker);
  return { wrap, button, picker };
});
$('#swatches').append(...swatches.map((s) => s.wrap));

const sizes = ['Thin', 'Medium', 'Thick'].map((label, i) => {
  const b = el('button', 'size');
  b.style.setProperty('--d', `${4 + i * 3.5}px`);
  b.setAttribute('aria-label', label);
  b.onclick = () => {
    palette().size = i;
    toolsChanged();
  };
  return b;
});
$('#sizes').append(...sizes);

$('#undo').onclick = () => ink.undo();
$('#redo').onclick = () => ink.redo();

const dark = matchMedia('(prefers-color-scheme: dark)');
dark.addEventListener('change', updateInkTools);

function updateInkTools() {
  const tool = tools.tool;
  for (const [name, b] of toolButtons) b.setAttribute('aria-pressed', String(name === tool));
  const pen = $('#tool-pen');
  pen.innerHTML = icon(tools.pen);
  pen.setAttribute('aria-label', tools.pen === 'fountain' ? 'Fountain pen' : 'Ballpoint pen');
  // With a selection, the lasso shows the pen colors to recolor it with.
  const drawing = tool === 'pen' || tool === 'highlighter';
  $('#swatches').hidden = !drawing && !(tool === 'lasso' && ink.hasSelection);
  $('#sizes').hidden = !drawing;
  const p = palette();
  swatches.forEach(({ wrap, button, picker }, i) => {
    const chosen = drawing && p.color === i;
    wrap.style.setProperty('--c', displayColor(p.colors[i], dark.matches));
    wrap.classList.toggle('chosen', chosen);
    picker.value = p.colors[i];
    button.setAttribute('aria-pressed', String(chosen));
    button.setAttribute('aria-label', tool === 'lasso' ? `Recolor selection with color ${i + 1}` : `Color ${i + 1}`);
  });
  sizes.forEach((b, i) => b.setAttribute('aria-pressed', String(drawing && p.size === i)));
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
  const isInk = session.kind === 'ink';
  $('#note-paper-row').hidden = !isInk;
  $('#note-export').hidden = !isInk;
  $<HTMLSelectElement>('#note-paper').value = ink.currentPaper;
  noteDialog.returnValue = '';
  noteDialog.showModal();
}

// Paper changes straight away, and new notes start on the last paper picked.
$<HTMLSelectElement>('#note-paper').onchange = (e) => {
  const paper = (e.target as HTMLSelectElement).value as Paper;
  ink.setPaper(paper);
  tools.paper = paper;
  saveTools(tools);
};
$('#note-export').onclick = () => {
  noteDialog.close();
  void exportCurrent();
};

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
  $<HTMLInputElement>('#s-snap').checked = tools.snap;
  $('#s-msg').textContent = '';
  closeDrawer();
  settingsDialog.showModal();
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  tools.snap = $<HTMLInputElement>('#s-snap').checked;
  saveTools(tools);
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

/** Runs `use` with the file picked in a hidden file input. */
function picker(input: HTMLInputElement, use: (file: File) => void) {
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) use(file);
  };
  return () => input.click();
}
$('#insert-photo').onclick = picker($<HTMLInputElement>('#photo-input'), (f) => void insertPhoto(f));
$('#import-pdf').onclick = picker($<HTMLInputElement>('#pdf-input'), (f) => void importPdf(f));
// Pasting or dropping a picture adds it to the page; dropping a PDF starts a note on it.
document.addEventListener('paste', (e) => {
  const image = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!image || session.kind !== 'ink' || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  void insertPhoto(image);
});
$('#editor').addEventListener('dragover', (e) => e.preventDefault());
$('#editor').addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  e.preventDefault();
  if (isPdf(file)) void importPdf(file);
  else if (file.type.startsWith('image/')) void insertPhoto(file);
});
$('#status').onclick = () => {
  if (!isConfigured(settings)) return openSettings();
  toast(statusText()[1]);
  void syncNow();
};

document.addEventListener('keydown', (e) => {
  if (session.kind !== 'ink' || document.querySelector('dialog[open]')) return;
  if (ink.hasSelection && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    return ink.deleteSelection();
  }
  if (e.key === 'Escape') return ink.clearSelection();
  if (!(e.metaKey || e.ctrlKey)) return;
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
  // Only pull in the background when you're not mid-writing.
  if (document.visibilityState === 'visible' && Date.now() - lastEdit > EDIT_SYNC_DELAY) void syncNow();
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

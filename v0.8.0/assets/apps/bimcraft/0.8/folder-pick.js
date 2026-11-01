/* SPDX-License-Identifier: Apache-2.0 */
/**
 * folder-pick.js — turns a folder the user chose into { name, files: [{ path, file }], skipped }
 * for folder-scan.js. Nothing is read here beyond the directory listing: File objects are
 * handles, and the scan reads only the byte ranges it needs. Three ways in:
 *
 *   pickFolder()        File System Access picker (Chrome, Edge): a one-time permission prompt;
 *                       the handle can be remembered (rememberFolder) and reopened (reopenFolder)
 *   fromInput(files)    <input webkitdirectory> fallback (Firefox, Safari)
 *   fromDropEntries(e)  a folder dragged onto the page — no prompt at all: the drag is the
 *                       permission (entries taken synchronously in the drop handler, walked after)
 * Revit housekeeping folders (<name>_backup, <name>_log, Revit_temp) are noted, not walked.
 */
import { HOUSEKEEPING_DIR } from './folder-scan.js';
import { t } from "./i18n.js";

export const MAX_FILES = 20000;

/** The error for a folder over MAX_FILES (its message is shown to the person). */
const tooMany = () => new Error(t('folder.toomany', { max: MAX_FILES.toLocaleString('en-US') }));

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

/** The browser's folder picker (Chrome/Edge show a one-time "view files" permission prompt). */
export async function pickFolder(onCount = () => {}) {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'bimcraft-folder', mode: 'read' });
  } catch (e) {
    if (e && e.name === 'AbortError') return null;   // the user closed the picker
    throw e;
  }
  return fromHandle(dir, onCount);
}

/** Walk a directory handle. The result keeps `handle` so the folder can be remembered. */
export async function fromHandle(dir, onCount = () => {}) {
  const out = { name: dir.name, files: [], skipped: [], handle: dir };
  async function walk(h, prefix) {
    for await (const [name, child] of h.entries()) {
      const path = prefix ? prefix + '/' + name : name;
      if (child.kind === 'directory') {
        if (HOUSEKEEPING_DIR.test(name)) out.skipped.push(path);
        else await walk(child, path);
      } else {
        if (out.files.length >= MAX_FILES) throw tooMany();
        out.files.push({ path, file: await child.getFile() });
        if (out.files.length % 50 === 0) onCount(out.files.length);
      }
    }
  }
  await walk(dir, '');
  return out;
}

/*
 * Recent folders (Chrome/Edge): directory handles kept in this browser's IndexedDB — never sent
 * anywhere. Reopening needs no prompt while the browser keeps the grant; after a restart Chrome
 * asks once and offers "Allow on every visit". Storage can be missing (private window): every
 * call fails soft to "no recent folders".
 */
const RECENT_MAX = 5;
function recentDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('bimcraft', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('recent-folders');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function recentTx(mode, fn) {
  const db = await recentDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recent-folders', mode);
    const req = fn(tx.objectStore('recent-folders'));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

export async function recentFolders() {
  if (!canPickFolder() || typeof indexedDB === 'undefined') return [];
  try { return (await recentTx('readonly', (st) => st.get('list'))) || []; } catch (e) { return []; }
}

export async function rememberFolder(handle) {
  if (!handle || typeof indexedDB === 'undefined') return;
  try {
    const list = await recentFolders();
    const kept = [];
    for (const r of list) if (!(await r.handle.isSameEntry(handle).catch(() => false))) kept.push(r);
    const next = [{ name: handle.name, handle, at: Date.now() }, ...kept].slice(0, RECENT_MAX);
    await recentTx('readwrite', (st) => st.put(next, 'list'));
  } catch (e) { /* no storage: nothing to remember */ }
}

export async function forgetFolder(index) {
  try {
    const list = await recentFolders();
    list.splice(index, 1);
    await recentTx('readwrite', (st) => st.put(list, 'list'));
  } catch (e) { /* nothing to forget */ }
}

/** Reopen a remembered folder: asks only if the browser no longer holds the grant. */
export async function reopenFolder(entry, onCount = () => {}) {
  const h = entry.handle;
  let perm = await h.queryPermission({ mode: 'read' });
  if (perm !== 'granted') perm = await h.requestPermission({ mode: 'read' });
  if (perm !== 'granted') return null;
  return fromHandle(h, onCount);
}

/** <input webkitdirectory>: webkitRelativePath is "Picked/sub/file.ext"; paths drop "Picked/". */
export function fromInput(fileList) {
  const list = [...fileList];
  if (!list.length) return null;
  const name = (list[0].webkitRelativePath || '').split('/')[0] || t('folder.kind');
  if (list.length > MAX_FILES) throw tooMany();
  return {
    name,
    files: list.map((f) => ({ path: (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name, file: f })),
    skipped: [],
  };
}

/**
 * Call synchronously inside the drop handler: the items vanish once the event returns.
 * Chrome/Edge also hand over a reusable handle (getAsFileSystemHandle) — no prompt, and the
 * folder can be remembered like a picked one.
 */
export function dropEntries(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
  return {
    entries: items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean),
    handles: items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null)).filter(Boolean),
  };
}

/** The dropped folder as a directory handle (Chrome/Edge), or null. */
export async function dropFolderHandle(drop) {
  for (const p of drop.handles) {
    const h = await p;
    if (h && h.kind === 'directory') return h;
  }
  return null;
}

export async function fromDropEntries(entries, onCount = () => {}) {
  const dir = entries.find((e) => e.isDirectory);
  if (!dir) return null;
  const out = { name: dir.name, files: [], skipped: [] };
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); next(); } }, reject);
    next();
  });
  async function walk(entry, prefix) {
    for (const child of await readAll(entry.createReader())) {
      const path = prefix ? prefix + '/' + child.name : child.name;
      if (child.isDirectory) {
        if (HOUSEKEEPING_DIR.test(child.name)) out.skipped.push(path);
        else await walk(child, path);
      } else {
        if (out.files.length >= MAX_FILES) throw tooMany();
        out.files.push({ path, file: await new Promise((res, rej) => child.file(res, rej)) });
        if (out.files.length % 50 === 0) onCount(out.files.length);
      }
    }
  }
  await walk(dir, '');
  return out;
}

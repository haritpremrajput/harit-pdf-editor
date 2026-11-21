// File I/O: uses local desktop bridge when present, otherwise browser-only local APIs.
const bridge = window.haritPdf;
export const isDesktop = !!bridge;

const PDF_FILTER = [{ name: 'PDF files', extensions: ['pdf'] }];
const IMG_FILTER = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }];

function browserPick(accept, multi) {
  return new Promise((resolve) => {
    const input = document.getElementById('fileInput');
    input.value = '';
    input.accept = accept;
    input.multiple = multi;
    const done = async () => {
      input.onchange = input.oncancel = null;
      const files = [...(input.files || [])];
      resolve(await Promise.all(files.map(fileToEntry)));
    };
    input.onchange = done;
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function fileToEntry(file) {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type };
}

export async function pickPdfs(multi = false) {
  if (bridge) return bridge.openFiles(PDF_FILTER, multi);
  return browserPick('application/pdf,.pdf', multi);
}

export async function pickImages(multi = true) {
  if (bridge) return bridge.openFiles(IMG_FILTER, multi);
  return browserPick('image/*', multi);
}

function download(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', txt: 'text/plain' };
function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }

/** Returns the saved path (desktop) or true (browser download). */
export async function saveFile(name, bytes) {
  const ext = extOf(name);
  if (bridge) {
    const label = { pdf: 'PDF file', png: 'PNG image', jpg: 'JPG image', txt: 'Text file' }[ext] || 'File';
    return bridge.saveFile(name, bytes, [{ name: label, extensions: [ext] }]);
  }
  download(name, bytes, MIME[ext] || 'application/octet-stream');
  return true;
}

/** Save several files into one folder. Returns folder path (desktop), true (browser) or null. */
export async function saveMany(files, zipName = 'files.zip') {
  if (bridge) return bridge.saveMany(files);
  if (files.length === 1) return saveFile(files[0].name, files[0].bytes);
  return saveFile(zipName, makeZip(files));
}

// ---- minimal ZIP writer (stored, no compression) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const f of files) {
    let name = f.name, i = 1;
    while (used.has(name)) name = f.name.replace(/(\.[^.]+)?$/, ` (${i++})$1`);
    used.add(name);
    const nb = enc.encode(name), data = f.bytes, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const csize = central.reduce((n, p) => n + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export function showInFolder(p) { if (bridge && typeof p === 'string') bridge.showInFolder(p); }
export async function pendingFiles() { return bridge ? bridge.pendingFiles() : []; }
export function onOpenPaths(cb) { if (bridge) bridge.onOpenPaths(async (paths) => cb(await bridge.readPaths(paths))); }
export function setDirty(d) { if (bridge && bridge.setDirty) bridge.setDirty(d); }

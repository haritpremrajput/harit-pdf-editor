// Harit PDF — renderer
import * as pdfjsLib from './pdf.min.js?v=3';
import { hydrateIcons } from './icons.js?v=3';
import * as io from './io.js?v=3';
import { buildPdf, imagesToPdf, blankPdf, rasterizePdf, optimizePdf, canEdit, BASELINE, LINE_H } from './pdfbuild.js?v=3';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js?v=3', import.meta.url).href;
// On the web build, binary font/cmap data ships as base64 .txt files (hosts only serve known file types).
function b64ToBytes(t) { const bin = atob(t.trim()); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
// cmaps and standard fonts are bundled into one JSON file per folder (keeps the site small to upload)
const bundles = {};
function loadBundle(dir) {
  if (!bundles[dir]) bundles[dir] = fetch(dir.replace(/\/$/, '') + '.json').then((r) => { if (!r.ok) throw new Error('missing ' + dir); return r.json(); });
  return bundles[dir];
}
async function fetchB64(url) {
  const i = url.lastIndexOf('/');
  const b = await loadBundle(url.slice(0, i + 1));
  const name = url.slice(i + 1);
  if (!b[name]) throw new Error('missing ' + name);
  return b64ToBytes(b[name]);
}
class WebCMapFactory {
  constructor({ baseUrl }) { this.baseUrl = baseUrl; }
  async fetch({ name }) { return { cMapData: await fetchB64(this.baseUrl + name + '.bcmap'), isCompressed: true }; }
}
class WebFontFactory {
  constructor({ baseUrl }) { this.baseUrl = baseUrl; }
  async fetch({ filename }) { return fetchB64(this.baseUrl + filename); }
}
const PDFJS_OPTS = {
  cMapUrl: new URL('./cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
  ...(io.isDesktop ? {} : { CMapReaderFactory: WebCMapFactory, StandardFontDataFactory: WebFontFactory, useWorkerFetch: false }),
};
const AM = pdfjsLib.AnnotationMode;
const CSS_UNITS = 96 / 72;
const COLORS = ['#1B1B1F', '#E5383B', '#FF6A13', '#17924A', '#2F5BFF', '#7444E6', '#FFFFFF'];
const HL_COLORS = ['#FFE14D', '#8CF0A8', '#FF9EC7', '#9EC5FF', '#FFB37A'];
const FONT_CSS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

// ------------------------------------------------------------------ state
const S = {
  sources: new Map(), // id -> {id, name, bytes, pdf, raster, hasForm}
  pages: [],          // {uid, src, idx, rot, baseRot, w0, h0, annots: []}
  zoom: 1,
  tool: 'select',
  current: 0,
  sel: new Set(),     // selected page uids (Pages view)
  lastSel: null,
  selAnn: null,       // {uid, id}
  formValues: new Map(),
  fieldMeta: new Map(),
  undo: [], redo: [],
  dirty: false,
  mode: 'edit',
  style: { color: '#1B1B1F', font: 'Helvetica', bold: false, size: 14, stroke: 3, fill: false, hl: HL_COLORS[0] },
  docName: '',
};
let uidCounter = 1;
const uid = (p = 'u') => `${p}${uidCounter++}`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const scale = () => S.zoom * CSS_UNITS;
const rotOf = (p) => (((p.baseRot + p.rot) % 360) + 360) % 360;
const dispSize = (p) => (rotOf(p) % 180 ? { w: p.h0, h: p.w0 } : { w: p.w0, h: p.h0 });
const pageByUid = (u) => S.pages.find((p) => p.uid === u);
const baseName = () => (S.docName || 'document').replace(/\.pdf$/i, '');

// ------------------------------------------------------------------ ui helpers
function toast(msg, { err = false, action = null, ms = 4200 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.innerHTML = `<span></span>`;
  t.firstChild.textContent = msg;
  if (action) {
    const a = document.createElement('a');
    a.textContent = action.label;
    a.onclick = () => { action.run(); t.remove(); };
    t.appendChild(a);
  }
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function busy(text) {
  if (text === false) { $('#busy').classList.add('hidden'); return; }
  $('#busyText').textContent = text || 'Working…';
  $('#busy').classList.remove('hidden');
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Small promise-based dialog. Returns input value / true, or null if cancelled. */
function ask({ title, message = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-card small"><div class="modal-head"><h2></h2></div><p class="muted" style="margin:0"></p>
      ${input ? `<input class="ask-in" style="height:38px;border:1px solid var(--line);border-radius:8px;padding:0 10px" />` : ''}
      <div class="modal-foot"><span></span><div style="display:flex;gap:8px"><button class="btn c">${cancel}</button><button class="btn primary o">${ok}</button></div></div></div>`;
    $('h2', m).textContent = title;
    $('p', m).textContent = message;
    if (danger) $('.o', m).style.background = 'var(--red)';
    const inp = $('.ask-in', m);
    if (inp) { inp.type = input.type || 'text'; inp.placeholder = input.placeholder || ''; inp.value = input.value || ''; }
    const close = (v) => { m.remove(); resolve(v); };
    $('.c', m).onclick = () => close(null);
    $('.o', m).onclick = () => close(inp ? inp.value : true);
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('.o', m).click(); }
      if (e.key === 'Escape') close(null);
    });
    document.body.appendChild(m);
    setTimeout(() => (inp || $('.o', m)).focus(), 20);
  });
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ------------------------------------------------------------------ history
function snapshot() {
  return {
    pages: S.pages.map((p) => ({ ...p, annots: p.annots.map((a) => ({ ...a })) })),
    formValues: new Map(S.formValues),
  };
}
function pushHistory(snap = snapshot()) {
  S.undo.push(snap);
  if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  markDirty();
}
function markDirty() {
  S.dirty = true;
  io.setDirty(true);
  updateButtons();
}
function layoutKey(pages) { return pages.map((p) => p.uid + ':' + p.rot).join(','); }
function restore(snap) {
  const before = layoutKey(S.pages);
  S.pages = snap.pages;
  S.formValues = snap.formValues;
  S.selAnn = null;
  if (before === layoutKey(S.pages)) {
    S.pages.forEach((p) => { const el = pageEl(p.uid); if (el) { renderOverlay(p, el); el._tlKey = null; if (S.sources.get(p.src).hasForm) buildFormLayer(p, el); } });
    if (S.tool === 'edittext') refreshTextLayers();
  } else {
    rebuildAll();
  }
  updateProps();
  updateButtons();
}
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); markDirty(); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); markDirty(); }

// ------------------------------------------------------------------ loading
const pageCache = new Map();
function getPage(srcId, idx) {
  const k = srcId + ':' + idx;
  if (!pageCache.has(k)) pageCache.set(k, S.sources.get(srcId).pdf.getPage(idx + 1));
  return pageCache.get(k);
}
const textCache = new Map();
function getText(srcId, idx) {
  const k = srcId + ':' + idx;
  if (!textCache.has(k)) textCache.set(k, getPage(srcId, idx).then((pg) => pg.getTextContent()));
  return textCache.get(k);
}

async function loadSource(entry) {
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: entry.bytes.slice() });
  task.onPassword = async (update, reason) => {
    const pw = await ask({
      title: 'Password required',
      message: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'That password was wrong. Try again.' : `“${entry.name}” is password-protected.`,
      input: { type: 'password', placeholder: 'Password' }, ok: 'Unlock',
    });
    if (pw == null) task.destroy(); else update(pw);
  };
  const pdf = await task.promise;
  const id = uid('s');
  const editable = await canEdit(entry.bytes);
  let hasForm = false;
  try { const fo = await pdf.getFieldObjects(); hasForm = !!fo && Object.keys(fo).length > 0; } catch { /* no form */ }
  const src = { id, name: entry.name, bytes: entry.bytes, pdf, raster: !editable, hasForm };
  S.sources.set(id, src);
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const pj = await getPage(id, i);
    const vp = pj.getViewport({ scale: 1, rotation: 0 });
    pages.push({ uid: uid('p'), src: id, idx: i, rot: 0, baseRot: pj.rotate || 0, w0: vp.width, h0: vp.height, annots: [] });
  }
  return { src, pages };
}

async function openEntries(entries, { append = false, at = null } = {}) {
  entries = entries.filter((e) => e && e.bytes && e.bytes.length);
  if (!entries.length) return;
  if (!append && S.dirty && S.pages.length) {
    const ok = await ask({ title: 'Discard unsaved changes?', message: 'You have edits that are not saved yet. Opening another file will discard them.', ok: 'Discard & open', danger: true });
    if (!ok) return;
  }
  busy(entries.length > 1 ? `Opening ${entries.length} files…` : `Opening ${entries[0].name}…`);
  try {
    const loaded = [];
    for (const e of entries) {
      try { loaded.push(await loadSource(e)); }
      catch (err) {
        console.error(err);
        if (err?.name !== 'PasswordException') toast(`Couldn't open ${e.name}. It may be damaged or not a PDF.`, { err: true });
      }
    }
    if (!loaded.length) return;
    const newPages = loaded.flatMap((l) => l.pages);
    if (!append || !S.pages.length) {
      S.pages = newPages;
      S.undo = []; S.redo = [];
      S.formValues = new Map(); S.fieldMeta = new Map();
      S.sel = new Set(); S.selAnn = null; S.current = 0;
      S.docName = entries.length > 1 ? 'Merged.pdf' : loaded[0].src.name;
      S.dirty = entries.length > 1;
      io.setDirty(S.dirty);
      // clear sources that are no longer used
      for (const id of [...S.sources.keys()]) if (!loaded.some((l) => l.src.id === id)) S.sources.delete(id);
      await fitWidth(false);
    } else {
      pushHistory();
      const pos = at == null ? S.pages.length : at;
      S.pages.splice(pos, 0, ...newPages);
      S.sel = new Set(newPages.map((p) => p.uid));
    }
    rebuildAll();
    const raster = loaded.filter((l) => l.src.raster);
    if (raster.length) toast('This PDF is locked against editing. Your changes will be saved on top of an image copy of its pages.', { ms: 7000 });
    if (loaded.some((l) => l.src.hasForm) && !append) toast('This PDF has form fields. Use the Forms tool to fill them in.', { action: { label: 'Fill form', run: () => setTool('forms') }, ms: 7000 });
    if (append) toast(`Added ${newPages.length} page${newPages.length > 1 ? 's' : ''}.`);
  } finally { busy(false); }
}

function addGeneratedSource(name, bytes, opts) { return openEntries([{ name, bytes }], opts); }

// ------------------------------------------------------------------ edit view: pages
const io_ = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const el = e.target;
    const p = pageByUid(el.dataset.uid);
    if (p && el._zoom !== S.zoom) renderPageCanvas(p, el);
  }
}, { root: $('#pagesScroll'), rootMargin: '900px 0px' });

function pageEl(u) { return $(`.page[data-uid="${u}"]`, $('#pages')); }

function rebuildAll() {
  rebuildEdit();
  rebuildThumbs();
  if (S.mode === 'pages') rebuildOrg();
  updateButtons();
  updateStatus();
}

function rebuildEdit() {
  const cont = $('#pages');
  const scroller = $('#pagesScroll');
  const keepIdx = S.current;
  $$('.page', cont).forEach((el) => { io_.unobserve(el); el._task?.cancel(); });
  cont.innerHTML = '';
  $('#empty').classList.toggle('hidden', S.pages.length > 0);
  const sc = scale();
  S.pages.forEach((p, i) => {
    const d = dispSize(p);
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.uid = p.uid;
    el.style.width = d.w * sc + 'px';
    el.style.height = d.h * sc + 'px';
    el.innerHTML = `<span class="page-num">${i + 1}</span><canvas class="render"></canvas><div class="overlay"></div><div class="textlayer"></div><div class="formlayer"></div>`;
    el._zoom = null;
    cont.appendChild(el);
    renderOverlay(p, el);
    if (S.sources.get(p.src).hasForm) buildFormLayer(p, el);
    io_.observe(el);
  });
  applyToolClasses();
  if (S.tool === 'edittext') refreshTextLayers();
  // restore scroll to current page
  const el = cont.children[Math.min(keepIdx, S.pages.length - 1)];
  if (el) scroller.scrollTop = el.offsetTop - 26;
}

async function renderPageCanvas(p, el) {
  el._zoom = S.zoom;
  const src = S.sources.get(p.src);
  const pj = await getPage(p.src, p.idx);
  const vp = pj.getViewport({ scale: scale() * dpr(), rotation: rotOf(p) });
  const canvas = $('canvas.render', el);
  el._task?.cancel();
  const off = document.createElement('canvas');
  off.width = Math.floor(vp.width);
  off.height = Math.floor(vp.height);
  const task = pj.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: src.hasForm ? AM.ENABLE_FORMS : AM.ENABLE });
  el._task = task;
  try {
    await task.promise;
    canvas.width = off.width; canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    el._rendered = true;
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    el._zoom = null;
  }
}

// ---- annotation geometry helpers
function spaceDims(p, rot) { return rot % 180 ? { W: p.h0, H: p.w0 } : { W: p.w0, H: p.h0 }; }
function deltaRot(a, p) { return (((rotOf(p) - (a.rot || 0)) % 360) + 360) % 360; }
/** point in annotation space -> current display space */
function toCurrent(p, a, x, y) {
  let { W, H } = spaceDims(p, a.rot || 0);
  for (let s = 0; s < deltaRot(a, p) / 90; s++) { [x, y, W, H] = [H - y, x, H, W]; }
  return { x, y };
}
/** vector in current display space -> annotation space */
function vecToAnn(p, a, dx, dy) {
  for (let s = 0; s < deltaRot(a, p) / 90; s++) [dx, dy] = [dy, -dx];
  return { dx, dy };
}
// ---- overlay rendering
function renderOverlay(p, el) {
  const ov = $('.overlay', el);
  ov.innerHTML = '';
  for (const a of p.annots) ov.appendChild(makeAnnEl(p, a));
}

function makeAnnEl(p, a) {
  const d = document.createElement('div');
  d.className = 'ann ann-' + a.type;
  d.dataset.id = a.id;
  if (S.selAnn && S.selAnn.id === a.id) d.classList.add('sel');
  if (a.type === 'text') {
    const t = document.createElement('div');
    t.className = 'ann-text';
    t.textContent = a.text;
    d.appendChild(t);
  } else if (a.type === 'image') {
    const img = document.createElement('img');
    img.src = a.src;
    img.draggable = false;
    d.appendChild(img);
  } else if (a.type === 'ink') {
    const pts = a.points.map((q) => q.join(',')).join(' ');
    d.innerHTML = `<svg viewBox="0 0 ${a.w0} ${a.h0}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${a.color}" stroke-width="${a.stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const h = document.createElement('div');
  h.className = 'handle';
  d.appendChild(h);
  styleAnnEl(p, a, d);
  return d;
}

function styleAnnEl(p, a, d) {
  const sc = scale();
  const pt = toCurrent(p, a, a.x, a.y);
  d.style.left = pt.x * sc + 'px';
  d.style.top = pt.y * sc + 'px';
  const dr = deltaRot(a, p);
  d.style.transform = dr ? `rotate(${dr}deg)` : '';
  if (a.type === 'text') {
    const t = d.firstChild;
    t.style.fontFamily = FONT_CSS[a.font] || FONT_CSS.Helvetica;
    t.style.fontWeight = a.bold ? '700' : '400';
    t.style.fontSize = a.size * sc + 'px';
    t.style.lineHeight = LINE_H;
    t.style.color = a.color;
    d.style.width = d.style.height = '';
    // keep measured size for later (in points)
    requestAnimationFrame(() => { if (d.isConnected) { a.w = d.offsetWidth / sc; a.h = d.offsetHeight / sc; } });
  } else {
    d.style.width = a.w * sc + 'px';
    d.style.height = a.h * sc + 'px';
    if (a.type === 'highlight') { d.style.background = a.color; d.style.opacity = 0.4; d.style.mixBlendMode = 'multiply'; }
    if (a.type === 'whiteout') d.style.background = a.color || '#fff';
    if (a.type === 'rect') {
      d.style.background = a.fill ? a.color : 'transparent';
      d.style.border = a.fill ? '0' : `${a.stroke * sc}px solid ${a.color}`;
    }
  }
}

function findAnn(id) {
  for (const p of S.pages) { const a = p.annots.find((x) => x.id === id); if (a) return { p, a }; }
  return null;
}

function selectAnn(p, a) {
  S.selAnn = a ? { uid: p.uid, id: a.id } : null;
  $$('.ann.sel').forEach((e) => e.classList.remove('sel'));
  if (a) { const e = $(`.ann[data-id="${a.id}"]`); e?.classList.add('sel'); syncStyleFromAnn(a); }
  updateProps();
}

function addAnn(p, a, { select = true } = {}) {
  a.id = a.id || uid('a');
  p.annots.push(a);
  const el = pageEl(p.uid);
  if (el) $('.overlay', el).appendChild(makeAnnEl(p, a));
  if (select) selectAnn(p, a);
  return a;
}

function removeAnn(id) {
  const f = findAnn(id);
  if (!f) return;
  pushHistory();
  f.p.annots = f.p.annots.filter((x) => x.id !== id);
  $(`.ann[data-id="${id}"]`)?.remove();
  if (S.selAnn?.id === id) selectAnn(null, null);
  if (f.a.origKey != null) { const el = pageEl(f.p.uid); if (el) el._tlKey = null; refreshTextLayers(); }
}

function duplicateSel() {
  if (!S.selAnn) return;
  const f = findAnn(S.selAnn.id);
  if (!f) return;
  pushHistory();
  const c = { ...f.a, id: uid('a'), x: f.a.x + 12, y: f.a.y + 12, origKey: undefined };
  addAnn(f.p, c);
}

// ---- text editing
function startTextEdit(p, a, d, caretPoint = null) {
  const t = d.firstChild;
  if (t.isContentEditable) return;
  selectAnn(p, a);
  let pushed = false;
  const snap = snapshot();
  t.contentEditable = 'plaintext-only';
  t.spellcheck = false;
  t.focus();
  const sel = window.getSelection();
  let range = null;
  if (caretPoint && document.caretRangeFromPoint) range = document.caretRangeFromPoint(caretPoint.x, caretPoint.y);
  if (!range || !t.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(t); range.collapse(false); }
  sel.removeAllRanges(); sel.addRange(range);
  t.oninput = () => {
    if (!pushed) { pushHistory(snap); pushed = true; }
    a.text = t.innerText.replace(/\n$/, '');
    a.w = d.offsetWidth / scale(); a.h = d.offsetHeight / scale();
  };
  t.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
    e.stopPropagation();
  };
  t.onblur = () => {
    t.contentEditable = 'false';
    t.oninput = t.onblur = t.onkeydown = null;
    if (!a.text.trim() && a.origKey == null) {
      p.annots = p.annots.filter((x) => x !== a);
      d.remove();
      if (S.selAnn?.id === a.id) selectAnn(null, null);
    }
  };
}

function createTextAt(p, x, y) {
  pushHistory();
  const st = S.style;
  const a = addAnn(p, { type: 'text', x, y: y - st.size * 0.6, text: '', font: st.font, bold: st.bold, size: st.size, color: st.color === '#FFFFFF' ? '#1B1B1F' : st.color, rot: rotOf(p) });
  const d = $(`.ann[data-id="${a.id}"]`);
  startTextEdit(p, a, d);
}

// ---- pointer interactions on pages
let drag = null;

$('#pages').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pel = e.target.closest('.page');
  if (!pel) return;
  if (e.target.closest('.formlayer .ff') || e.target.closest('.tl-item')) return;
  const p = pageByUid(pel.dataset.uid);
  const ov = $('.overlay', pel);
  const r = ov.getBoundingClientRect();
  const sc = scale();
  const pt = { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  S.current = S.pages.indexOf(p);
  updateThumbCurrent();
  const annEl = e.target.closest('.ann');
  const tool = S.tool;

  if (annEl && annEl.firstChild?.isContentEditable) return; // let text editing work

  if (tool === 'select' || (tool === 'text' && annEl?.classList.contains('ann-text'))) {
    if (!annEl) { selectAnn(null, null); document.activeElement?.blur?.(); return; }
    const f = findAnn(annEl.dataset.id);
    if (!f) return;
    if (tool === 'text') { startTextEdit(f.p, f.a, annEl, { x: e.clientX, y: e.clientY }); return; }
    e.preventDefault();
    selectAnn(f.p, f.a);
    const isHandle = e.target.classList.contains('handle');
    drag = { kind: isHandle ? 'resize' : 'move', p: f.p, a: f.a, el: annEl, sx: e.clientX, sy: e.clientY, orig: { ...f.a }, snap: snapshot(), moved: false };
    annEl.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'text') { e.preventDefault(); createTextAt(p, pt.x, pt.y); return; }
  if (tool === 'highlight' || tool === 'rect' || tool === 'whiteout') {
    e.preventDefault();
    const box = document.createElement('div');
    box.className = 'drag-rect';
    ov.appendChild(box);
    drag = { kind: 'box', tool, p, ov, box, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    ov.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'draw') {
    e.preventDefault();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ink');
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', S.style.color);
    pl.setAttribute('stroke-width', S.style.stroke * sc);
    pl.setAttribute('stroke-linecap', 'round');
    pl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pl);
    ov.appendChild(svg);
    drag = { kind: 'ink', p, ov, svg, pl, pts: [[pt.x, pt.y]] };
    pl.setAttribute('points', `${pt.x * sc},${pt.y * sc}`);
    ov.setPointerCapture(e.pointerId);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const sc = scale();
  if (drag.kind === 'move' || drag.kind === 'resize') {
    const dxs = (e.clientX - drag.sx) / sc, dys = (e.clientY - drag.sy) / sc;
    if (!drag.moved && Math.hypot(dxs, dys) * sc < 2) return;
    if (!drag.moved) { pushHistory(drag.snap); drag.moved = true; }
    const { dx, dy } = vecToAnn(drag.p, drag.a, dxs, dys);
    const a = drag.a, o = drag.orig;
    if (drag.kind === 'move') { a.x = o.x + dx; a.y = o.y + dy; }
    else if (a.type === 'text') {
      const f = Math.max(0.2, (o.w + dx) / (o.w || 1));
      a.size = Math.max(4, Math.round(o.size * f * 10) / 10);
      syncStyleFromAnn(a);
    } else if (a.type === 'image' || a.type === 'ink') {
      const f = Math.max(0.05, (o.w + dx) / o.w);
      a.w = Math.max(4, o.w * f); a.h = Math.max(4, o.h * f);
    } else { a.w = Math.max(3, o.w + dx); a.h = Math.max(3, o.h + dy); }
    styleAnnEl(drag.p, a, drag.el);
  } else if (drag.kind === 'box') {
    const r = drag.ov.getBoundingClientRect();
    drag.x1 = Math.max(0, Math.min(r.width / sc, (e.clientX - r.left) / sc));
    drag.y1 = Math.max(0, Math.min(r.height / sc, (e.clientY - r.top) / sc));
    const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1);
    Object.assign(drag.box.style, { left: x * sc + 'px', top: y * sc + 'px', width: Math.abs(drag.x1 - drag.x0) * sc + 'px', height: Math.abs(drag.y1 - drag.y0) * sc + 'px' });
  } else if (drag.kind === 'ink') {
    const r = drag.ov.getBoundingClientRect();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) drag.pts.push([(ev.clientX - r.left) / sc, (ev.clientY - r.top) / sc]);
    drag.pl.setAttribute('points', drag.pts.map((q) => `${q[0] * sc},${q[1] * sc}`).join(' '));
  }
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'box') {
    d.box.remove();
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 3 || h < 3) return;
    pushHistory();
    const R = rotOf(d.p);
    const base = { x, y, w, h, rot: R };
    if (d.tool === 'highlight') addAnn(d.p, { type: 'highlight', ...base, color: S.style.hl }, { select: false });
    else if (d.tool === 'whiteout') {
      const el = pageEl(d.p.uid);
      const bg = sampleColors(el, d.p, { x, y, w, h }).bg;
      addAnn(d.p, { type: 'whiteout', ...base, color: bg }, { select: false });
    } else addAnn(d.p, { type: 'rect', ...base, color: S.style.color, stroke: S.style.stroke, fill: S.style.fill }, { select: false });
  } else if (d.kind === 'ink') {
    d.svg.remove();
    simplify(d.pts);
    const pad = S.style.stroke;
    const xs = d.pts.map((q) => q[0]), ys = d.pts.map((q) => q[1]);
    const minx = Math.min(...xs) - pad, miny = Math.min(...ys) - pad;
    const w = Math.max(1, Math.max(...xs) + pad - minx), h = Math.max(1, Math.max(...ys) + pad - miny);
    pushHistory();
    addAnn(d.p, {
      type: 'ink', x: minx, y: miny, w, h, w0: w, h0: h, rot: rotOf(d.p),
      points: d.pts.map((q) => [+(q[0] - minx).toFixed(2), +(q[1] - miny).toFixed(2)]),
      color: S.style.color, stroke: S.style.stroke,
    }, { select: false });
  }
});

function simplify(pts) {
  // drop points closer than 0.6pt to the previous kept point
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i][0] - l[0], pts[i][1] - l[1]) > 0.6) out.push(pts[i]);
  }
  pts.length = 0; pts.push(...out);
}

$('#pages').addEventListener('dblclick', (e) => {
  const annEl = e.target.closest('.ann-text');
  if (!annEl) return;
  const f = findAnn(annEl.dataset.id);
  if (f) startTextEdit(f.p, f.a, annEl, { x: e.clientX, y: e.clientY });
});

// ---- colour sampling for whiteout / edit text
function sampleColors(el, p, box) {
  const canvas = el && $('canvas.render', el);
  if (!canvas || !el._rendered || !canvas.width) return { bg: '#ffffff', fg: '#000000' };
  const f = canvas.width / dispSize(p).w;
  const pad = 2;
  const X = Math.max(0, Math.floor(box.x * f) - pad), Y = Math.max(0, Math.floor(box.y * f) - pad);
  const W = Math.min(canvas.width - X, Math.ceil(box.w * f) + pad * 2), H = Math.min(canvas.height - Y, Math.ceil(box.h * f) + pad * 2);
  if (W <= 0 || H <= 0) return { bg: '#ffffff', fg: '#000000' };
  let data;
  try { data = canvas.getContext('2d').getImageData(X, Y, W, H).data; } catch { return { bg: '#ffffff', fg: '#000000' }; }
  const counts = new Map();
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const add = (c) => { const k = c.map((v) => v >> 3).join(','); const e = counts.get(k) || { n: 0, c }; e.n++; counts.set(k, e); };
  for (let x = 0; x < W; x++) { add(px(x, 0)); add(px(x, H - 1)); }
  for (let y = 0; y < H; y++) { add(px(0, y)); add(px(W - 1, y)); }
  const bgc = [...counts.values()].sort((a, b) => b.n - a.n)[0].c;
  let best = null, bd = 0;
  for (let y = pad; y < H - pad; y += 1) for (let x = pad; x < W - pad; x += 1) {
    const c = px(x, y);
    const dd = Math.abs(c[0] - bgc[0]) + Math.abs(c[1] - bgc[1]) + Math.abs(c[2] - bgc[2]);
    if (dd > bd) { bd = dd; best = c; }
  }
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bgc), fg: best && bd > 120 ? hex(best) : '#000000' };
}

// ---- edit existing text
function refreshTextLayers() {
  $$('.page', $('#pages')).forEach((el) => {
    const p = pageByUid(el.dataset.uid);
    if (p) buildTextLayer(p, el);
  });
}

async function buildTextLayer(p, el) {
  const key = S.zoom + ':' + rotOf(p) + ':' + p.annots.length;
  if (el._tlKey === key) return;
  el._tlKey = key;
  const layer = $('.textlayer', el);
  const pj = await getPage(p.src, p.idx);
  const tc = await getText(p.src, p.idx);
  const vp = pj.getViewport({ scale: 1, rotation: rotOf(p) });
  const sc = scale();
  layer.innerHTML = '';
  el._tl = [];
  const done = new Set(p.annots.filter((a) => a.origKey != null).map((a) => a.origKey));
  tc.items.forEach((it, k) => {
    if (!it.str || !it.str.trim()) return;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) return;
    const fh = Math.hypot(tx[2], tx[3]);
    if (fh < 1) return;
    const st = tc.styles[it.fontName] || {};
    const asc = st.ascent || 0.8, desc = st.descent || -0.2;
    const item = { k, str: it.str, fh, baseline: tx[5], left: tx[4], top: tx[5] - fh * asc, width: it.width * (it.width && Math.abs(tx[0]) ? 1 : 1), height: fh * (asc - desc), fontName: it.fontName, family: st.fontFamily || '' };
    if (item.width <= 0) return;
    el._tl[k] = item;
    const d = document.createElement('div');
    d.className = 'tl-item' + (done.has(k) ? ' done' : '');
    d.dataset.k = k;
    Object.assign(d.style, { left: item.left * sc + 'px', top: item.top * sc + 'px', width: item.width * sc + 'px', height: item.height * sc + 'px' });
    d.title = 'Click to edit';
    layer.appendChild(d);
  });
}

$('#pages').addEventListener('click', async (e) => {
  const tl = e.target.closest('.tl-item');
  if (!tl || S.tool !== 'edittext') return;
  const el = tl.closest('.page');
  const p = pageByUid(el.dataset.uid);
  const it = el._tl?.[+tl.dataset.k];
  if (!it) return;
  pushHistory();
  const R = rotOf(p);
  const padX = it.fh * 0.06, padY = it.fh * 0.06;
  const box = { x: it.left - padX, y: it.top - padY, w: it.width + padX * 2, h: it.height + padY * 2 };
  const { bg, fg } = sampleColors(el, p, box);
  let family = 'Helvetica';
  if (/mono|courier/i.test(it.family + it.fontName)) family = 'Courier';
  else if (/serif/i.test(it.family) && !/sans/i.test(it.family)) family = 'Times';
  let bold = false;
  try {
    const pj = await getPage(p.src, p.idx);
    const fo = pj.commonObjs.has(it.fontName) ? pj.commonObjs.get(it.fontName) : null;
    const nm = (fo && (fo.name || fo.loadedName)) || '';
    bold = /bold|black|heavy|semibold|demi/i.test(nm);
    if (/times|serif|roman|georgia|garamond|minion|cambria/i.test(nm) && !/sans/i.test(nm)) family = 'Times';
    if (/courier|mono|consol/i.test(nm)) family = 'Courier';
  } catch { /* ignore */ }
  const size = Math.round(it.fh * 10) / 10;
  addAnn(p, { type: 'whiteout', ...box, color: bg, rot: R, origKey: it.k }, { select: false });
  const ta = addAnn(p, { type: 'text', x: it.left, y: it.baseline - (BASELINE[family] || 0.93) * size, text: it.str, font: family, bold, size, color: fg, rot: R, origKey: it.k });
  tl.classList.add('done');
  el._tlKey = null;
  const d = $(`.ann[data-id="${ta.id}"]`);
  requestAnimationFrame(() => startTextEdit(p, ta, d, { x: e.clientX, y: e.clientY }));
});

// ---- forms
async function buildFormLayer(p, el) {
  const layer = $('.formlayer', el);
  const pj = await getPage(p.src, p.idx);
  let anns;
  try { anns = await pj.getAnnotations({ intent: 'display' }); } catch { return; }
  const vp = pj.getViewport({ scale: scale(), rotation: rotOf(p) });
  layer.innerHTML = '';
  for (const a of anns) {
    if (a.subtype !== 'Widget' || !a.fieldName || a.hidden) continue;
    const key = p.src + '|' + a.fieldName;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
    const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    const has = S.formValues.has(key);
    const cur = S.formValues.get(key);
    let inp = null;
    if (a.fieldType === 'Tx') {
      inp = document.createElement(a.multiLine ? 'textarea' : 'input');
      inp.value = has ? cur : (a.fieldValue ?? '');
      if (a.maxLen) inp.maxLength = a.maxLen;
      inp.oninput = () => setFormValue(key, inp.value, { type: 'text' });
      inp.style.fontSize = Math.min(box.height * 0.62, 13 * scale()) + 'px';
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'cb';
      inp.checked = has ? !!cur : (a.fieldValue && a.fieldValue !== 'Off');
      inp.onchange = () => setFormValue(key, inp.checked, { type: 'checkbox' });
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      inp = document.createElement('input');
      inp.type = 'radio';
      inp.className = 'cb';
      inp.style.borderRadius = '50%';
      inp.name = key;
      inp.checked = has ? cur === a.buttonValue : a.fieldValue === a.buttonValue;
      inp.onchange = () => { if (inp.checked) { setFormValue(key, a.buttonValue, { type: 'radio' }); syncRadios(key, a.buttonValue); } };
      inp.dataset.bv = a.buttonValue;
    } else if (a.fieldType === 'Ch') {
      inp = document.createElement('select');
      const opts = a.options || [];
      if (a.combo) inp.appendChild(new Option('', ''));
      for (const o of opts) inp.appendChild(new Option(o.displayValue, o.exportValue));
      const v = has ? cur : (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue);
      inp.value = v ?? '';
      inp.onchange = () => setFormValue(key, inp.value, { type: 'choice', options: opts });
      inp.style.fontSize = Math.min(box.height * 0.62, 13 * scale()) + 'px';
    }
    if (!inp) continue;
    inp.classList.add('ff');
    inp.dataset.key = key;
    if (a.readOnly) inp.disabled = true;
    Object.assign(inp.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
    layer.appendChild(inp);
  }
}

function setFormValue(key, value, meta) {
  const snap = snapshot();
  if (!S._formTyping || S._formTyping !== key) { pushHistory(snap); S._formTyping = key; clearTimeout(S._ft); }
  S._ft = setTimeout(() => (S._formTyping = null), 1200);
  S.formValues.set(key, value);
  S.fieldMeta.set(key, meta);
  // keep the same field in sync on other pages / widgets
  $$(`.ff[data-key="${CSS.escape(key)}"]`).forEach((e) => {
    if (e === document.activeElement) return;
    if (e.type === 'checkbox') e.checked = !!value;
    else if (e.type === 'radio') e.checked = e.dataset.bv === value;
    else e.value = value;
  });
}
function syncRadios(key, v) { $$(`.ff[data-key="${CSS.escape(key)}"]`).forEach((e) => { if (e.type === 'radio') e.checked = e.dataset.bv === v; }); }

// ------------------------------------------------------------------ thumbnails
const renderQueue = [];
let renderActive = 0;
function queueRender(fn) {
  return new Promise((res) => { renderQueue.push(async () => { try { await fn(); } finally { res(); } }); pump(); });
}
function pump() {
  while (renderActive < 3 && renderQueue.length) {
    const job = renderQueue.shift();
    renderActive++;
    job().finally(() => { renderActive--; pump(); });
  }
}
async function drawThumb(p, canvas, maxW, maxH) {
  const pj = await getPage(p.src, p.idx);
  const v1 = pj.getViewport({ scale: 1, rotation: rotOf(p) });
  const s = Math.min(maxW / v1.width, maxH / v1.height);
  const vp = pj.getViewport({ scale: s * dpr(), rotation: rotOf(p) });
  canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(vp.width / dpr()) + 'px';
  canvas.style.height = Math.floor(vp.height / dpr()) + 'px';
  await pj.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
}

const thumbObs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting || e.target._done) continue;
    e.target._done = true;
    const p = pageByUid(e.target.dataset.uid);
    const c = $('canvas', e.target);
    if (p) queueRender(() => drawThumb(p, c, e.target._mw, e.target._mh));
    thumbObs.unobserve(e.target);
  }
}, { rootMargin: '400px' });

function rebuildThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  S.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === S.current ? ' current' : '');
    t.dataset.uid = p.uid;
    t._mw = 110; t._mh = 150;
    t.innerHTML = `<canvas></canvas><div>${i + 1}</div>`;
    t.onclick = () => scrollToPage(i);
    box.appendChild(t);
    thumbObs.observe(t);
  });
}
function updateThumbCurrent() {
  $$('.thumb', $('#thumbs')).forEach((t, i) => t.classList.toggle('current', i === S.current));
  updateStatus();
}
function scrollToPage(i) {
  const el = $('#pages').children[i];
  if (el) $('#pagesScroll').scrollTo({ top: el.offsetTop - 26, behavior: 'smooth' });
  S.current = i;
  updateThumbCurrent();
}
$('#pagesScroll').addEventListener('scroll', () => {
  const sc = $('#pagesScroll');
  const mid = sc.scrollTop + sc.clientHeight * 0.35;
  const kids = $('#pages').children;
  let cur = 0;
  for (let i = 0; i < kids.length; i++) { if (kids[i].offsetTop <= mid) cur = i; else break; }
  if (cur !== S.current) {
    S.current = cur;
    updateThumbCurrent();
    $('#thumbs').children[cur]?.scrollIntoView({ block: 'nearest' });
  }
}, { passive: true });

// ------------------------------------------------------------------ zoom
function setZoom(z) {
  z = Math.max(0.25, Math.min(4, z));
  if (Math.abs(z - S.zoom) < 0.001) return;
  S.zoom = z;
  $('#zoomLabel').textContent = Math.round(z * 100) + '%';
  rebuildEdit();
}
async function fitWidth(rebuild = true) {
  if (!S.pages.length) return;
  const avail = $('#pagesScroll').clientWidth - 84;
  // fit the typical page width (median) so one landscape page doesn't shrink everything
  const ws = S.pages.map((p) => dispSize(p).w).sort((a, b) => a - b);
  const maxW = ws[Math.floor(ws.length / 2)];
  const z = Math.max(0.25, Math.min(2.5, avail / (maxW * CSS_UNITS)));
  if (rebuild) setZoom(z);
  else { S.zoom = z; $('#zoomLabel').textContent = Math.round(z * 100) + '%'; }
}
$('#pagesScroll').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// ------------------------------------------------------------------ tools & properties
function setTool(t) {
  if (!S.pages.length && t !== 'select') { toast('Open a PDF first.'); return; }
  document.activeElement?.blur?.();
  if (t === 'image') { insertImageAnn(); t = 'select'; }
  if (t === 'sign') { openSignModal(); t = 'select'; }
  S.tool = t;
  $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  if (t !== 'select') selectAnn(null, null);
  applyToolClasses();
  if (t === 'edittext') refreshTextLayers();
  updateProps();
}
function applyToolClasses() {
  $$('.page', $('#pages')).forEach((el) => {
    const ov = $('.overlay', el);
    ov.className = 'overlay tool-' + S.tool;
    el.classList.toggle('forms', S.tool === 'forms');
    el.classList.toggle('edittext', S.tool === 'edittext');
  });
}
function propKey() {
  if (S.tool === 'select' && S.selAnn) {
    const f = findAnn(S.selAnn.id);
    if (f) return { text: 'text', rect: 'rect', ink: 'draw', highlight: 'highlight' }[f.a.type] || 'none';
  }
  return S.tool;
}
function updateProps() {
  const k = propKey();
  $$('.prop', $('#propbar')).forEach((el) => {
    const f = el.dataset.for;
    el.classList.toggle('show', !!f && f.split(' ').includes(k));
  });
  $('#selActions').classList.toggle('show', !!S.selAnn);
  if (S.tool === 'forms') {
    const any = S.pages.some((p) => S.sources.get(p.src).hasForm);
    $('#formsHint').textContent = any ? 'Click a field on the page to fill it.' : 'This PDF has no fillable fields. Use Add text to type on it instead.';
  }
}
function syncStyleFromAnn(a) {
  if (a.color && a.type !== 'highlight' && a.type !== 'whiteout') { S.style.color = a.color; $('#colorPick').value = a.color.length === 7 ? a.color : '#000000'; }
  if (a.type === 'text') { S.style.font = a.font; S.style.bold = a.bold; S.style.size = a.size; }
  if (a.stroke) S.style.stroke = a.stroke;
  if (a.type === 'rect') S.style.fill = a.fill;
  if (a.type === 'highlight') S.style.hl = a.color;
  reflectStyle();
}
function reflectStyle() {
  $('#fontSel').value = S.style.font;
  $('#boldBtn').classList.toggle('on', S.style.bold);
  $('#fontSize').value = S.style.size;
  $('#strokeW').value = S.style.stroke;
  $('#fillBtn').classList.toggle('on', S.style.fill);
  $$('#swatches .swatch').forEach((s) => s.classList.toggle('active', s.dataset.c.toLowerCase() === S.style.color.toLowerCase()));
  $$('#hlSwatches .swatch').forEach((s) => s.classList.toggle('active', s.dataset.c === S.style.hl));
}
/** apply a style change to the selected annotation (if any) */
function applyStyle(patch) {
  Object.assign(S.style, patch);
  reflectStyle();
  if (!S.selAnn) return;
  const f = findAnn(S.selAnn.id);
  if (!f) return;
  const a = f.a;
  const m = {};
  if ('color' in patch && ['text', 'rect', 'ink'].includes(a.type)) m.color = patch.color;
  if ('hl' in patch && a.type === 'highlight') m.color = patch.hl;
  if (a.type === 'text') { for (const k of ['font', 'bold', 'size']) if (k in patch) m[k] = patch[k]; }
  if ('stroke' in patch && (a.type === 'rect' || a.type === 'ink')) m.stroke = patch.stroke;
  if ('fill' in patch && a.type === 'rect') m.fill = patch.fill;
  if (!Object.keys(m).length) return;
  pushHistory();
  Object.assign(a, m);
  const old = $(`.ann[data-id="${a.id}"]`);
  const nu = makeAnnEl(f.p, a);
  old?.replaceWith(nu);
}

function buildSwatches() {
  const sw = $('#swatches');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.c = c; b.style.background = c; b.title = c;
    b.onclick = () => applyStyle({ color: c });
    sw.appendChild(b);
  });
  const hl = $('#hlSwatches');
  HL_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.c = c; b.style.background = c;
    b.onclick = () => applyStyle({ hl: c });
    hl.appendChild(b);
  });
  $('#colorPick').oninput = (e) => applyStyle({ color: e.target.value });
  $('#fontSel').onchange = (e) => applyStyle({ font: e.target.value });
  $('#boldBtn').onclick = () => applyStyle({ bold: !S.style.bold });
  $('#fontSize').onchange = (e) => applyStyle({ size: Math.max(4, Math.min(144, +e.target.value || 14)) });
  $('#strokeW').onchange = (e) => applyStyle({ stroke: +e.target.value });
  $('#fillBtn').onclick = () => applyStyle({ fill: !S.style.fill });
  reflectStyle();
}

// ---- images & signatures
async function fileToDataUrl(entry, maxDim = 2400) {
  const type = entry.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[entry.name.split('.').pop().toLowerCase()] || 'image/png');
  const bmp = await createImageBitmap(new Blob([entry.bytes], { type }), { imageOrientation: 'from-image' });
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const jpg = /jpe?g/.test(type);
  return { url: c.toDataURL(jpg ? 'image/jpeg' : 'image/png', 0.92), w: c.width, h: c.height };
}

function placeImage(url, w, h, maxFrac) {
  const p = S.pages[S.current] || S.pages[0];
  if (!p) return;
  const d = dispSize(p);
  const maxW = d.w * maxFrac;
  const k = Math.min(1, maxW / (w * 0.75), (d.h * 0.6) / (h * 0.75));
  const aw = w * 0.75 * k, ah = h * 0.75 * k;
  // place in the middle of the visible part of the page
  const el = pageEl(p.uid);
  const scroller = $('#pagesScroll');
  let cy = d.h / 2;
  if (el) {
    const visTop = (scroller.scrollTop - el.offsetTop) / scale();
    const visH = scroller.clientHeight / scale();
    cy = Math.max(ah / 2, Math.min(d.h - ah / 2, visTop + visH / 2));
  }
  pushHistory();
  addAnn(p, { type: 'image', x: (d.w - aw) / 2, y: cy - ah / 2, w: aw, h: ah, src: url, rot: rotOf(p) });
  setToolUI('select');
}
function setToolUI(t) { S.tool = t; $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); applyToolClasses(); updateProps(); }

async function insertImageAnn() {
  const [entry] = await io.pickImages(false);
  if (!entry) return;
  try {
    const { url, w, h } = await fileToDataUrl(entry);
    placeImage(url, w, h, 0.5);
  } catch (e) { console.error(e); toast("That image couldn't be read.", { err: true }); }
}

// signature modal
const sig = { strokes: [], color: '#1B1B1F', tab: 'draw', typeFont: 'Dancing Script', upload: null };
function loadSavedSigs() { try { return JSON.parse(localStorage.getItem('harit.sigs') || '[]'); } catch { return []; } }
function saveSigs(list) { try { localStorage.setItem('harit.sigs', JSON.stringify(list.slice(0, 6))); } catch { /* full */ } }
function renderSavedSigs() {
  const box = $('#savedSigs');
  box.innerHTML = '';
  loadSavedSigs().forEach((s, i) => {
    const d = document.createElement('div');
    d.className = 'saved-sig';
    d.innerHTML = `<img src="${s.url}"><button title="Remove">×</button>`;
    d.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') { const l = loadSavedSigs(); l.splice(i, 1); saveSigs(l); renderSavedSigs(); return; }
      closeModals(); placeImage(s.url, s.w, s.h, 0.3);
    };
    box.appendChild(d);
  });
}
function openSignModal() {
  if (!S.pages.length) return;
  sig.strokes = []; sig.upload = null;
  drawSigPad();
  renderSavedSigs();
  $('#signModal').classList.remove('hidden');
  updateTypePreview();
}
function closeModals() { $$('.modal').forEach((m) => { if (m.id) m.classList.add('hidden'); else m.remove(); }); }

function drawSigPad() {
  const c = $('#sigPad');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#e8e1d3'; g.lineWidth = 1.5; g.setLineDash([6, 6]);
  g.beginPath(); g.moveTo(40, c.height - 60); g.lineTo(c.width - 40, c.height - 60); g.stroke();
  g.setLineDash([]);
  g.lineCap = g.lineJoin = 'round';
  g.strokeStyle = sig.color;
  for (const s of sig.strokes) {
    g.lineWidth = 3.2;
    g.beginPath();
    s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (s.length === 1) g.lineTo(s[0][0] + 0.1, s[0][1]);
    g.stroke();
  }
}
(function bindSigPad() {
  const c = $('#sigPad');
  let cur = null;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)]; };
  c.addEventListener('pointerdown', (e) => { cur = [pos(e)]; sig.strokes.push(cur); c.setPointerCapture(e.pointerId); drawSigPad(); });
  c.addEventListener('pointermove', (e) => { if (!cur) return; (e.getCoalescedEvents?.() || [e]).forEach((ev) => cur.push(pos(ev))); drawSigPad(); });
  c.addEventListener('pointerup', () => { cur = null; });
  const sc = $('#sigColors');
  ['#1B1B1F', '#1D3FBF', '#B3261E'].forEach((col, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : ''); b.style.background = col;
    b.onclick = () => { sig.color = col; $$('.swatch', sc).forEach((x) => x.classList.toggle('active', x === b)); drawSigPad(); updateTypePreview(); };
    sc.appendChild(b);
  });
})();
function updateTypePreview() {
  const box = $('#sigTypePreview');
  const name = $('#sigText').value || 'Your Name';
  box.innerHTML = '';
  ['Dancing Script', 'Caveat'].forEach((f) => {
    const d = document.createElement('div');
    d.className = 'sig-opt' + (sig.typeFont === f ? ' active' : '');
    d.style.fontFamily = `'${f}'`; d.style.fontWeight = 600; d.style.color = sig.color;
    d.textContent = name;
    d.onclick = () => { sig.typeFont = f; updateTypePreview(); };
    box.appendChild(d);
  });
}
$('#sigText').addEventListener('input', updateTypePreview);
$$('.sig-tab').forEach((b) => b.onclick = () => {
  sig.tab = b.dataset.sigtab;
  $$('.sig-tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.sig-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.sigpane !== sig.tab));
});

/** Crop a canvas to its non-transparent content and return a PNG data URL. */
function cropCanvas(c) {
  const g = c.getContext('2d');
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const o = document.createElement('canvas');
  o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return { url: o.toDataURL('image/png'), w: o.width, h: o.height };
}

async function makeSignature() {
  if (sig.tab === 'draw') {
    if (!sig.strokes.length) return null;
    const c = document.createElement('canvas');
    c.width = $('#sigPad').width * 2; c.height = $('#sigPad').height * 2;
    const g = c.getContext('2d');
    g.scale(2, 2); g.lineCap = g.lineJoin = 'round'; g.strokeStyle = sig.color; g.lineWidth = 3.2;
    for (const s of sig.strokes) { g.beginPath(); s.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (s.length === 1) g.lineTo(s[0][0] + 0.1, s[0][1]); g.stroke(); }
    return cropCanvas(c);
  }
  if (sig.tab === 'type') {
    const name = $('#sigText').value.trim();
    if (!name) return null;
    await document.fonts.load(`600 120px '${sig.typeFont}'`);
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = `600 120px '${sig.typeFont}'`;
    c.width = Math.ceil(g.measureText(name).width + 60); c.height = 220;
    g.font = `600 120px '${sig.typeFont}'`;
    g.fillStyle = sig.color; g.textBaseline = 'middle';
    g.fillText(name, 30, 110);
    return cropCanvas(c);
  }
  return sig.upload;
}

async function sigUpload() {
  const [entry] = await io.pickImages(false);
  if (!entry) return;
  const { url } = await fileToDataUrl(entry, 1600);
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  // remove light background: alpha from darkness
  for (let i = 0; i < d.data.length; i += 4) {
    const l = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    const a = Math.max(0, Math.min(255, (205 - l) * 2.2));
    d.data[i + 3] = Math.min(d.data[i + 3], a);
  }
  g.putImageData(d, 0, 0);
  sig.upload = cropCanvas(c);
  const prev = $('#sigUploadPrev');
  prev.classList.remove('hidden');
  const pg = prev.getContext('2d');
  pg.clearRect(0, 0, prev.width, prev.height);
  if (sig.upload) {
    const im = new Image(); im.src = sig.upload.url; await im.decode();
    const k = Math.min((prev.width - 40) / im.width, (prev.height - 40) / im.height);
    pg.drawImage(im, (prev.width - im.width * k) / 2, (prev.height - im.height * k) / 2, im.width * k, im.height * k);
  }
}

async function useSignature() {
  const s = await makeSignature();
  if (!s) { toast('Draw, type or upload a signature first.'); return; }
  if ($('#sigRemember').checked) {
    const list = loadSavedSigs();
    if (!list.some((x) => x.url === s.url)) { list.unshift(s); saveSigs(list); }
  }
  closeModals();
  placeImage(s.url, s.w, s.h, 0.3);
}

// ------------------------------------------------------------------ pages (organise) view
function rebuildOrg() {
  const g = $('#orgGrid');
  g.innerHTML = '';
  const multiSrc = new Set(S.pages.map((p) => p.src)).size > 1;
  const srcIdx = new Map([...new Set(S.pages.map((p) => p.src))].map((s, i) => [s, i + 1]));
  S.pages.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'org-page' + (S.sel.has(p.uid) ? ' selected' : '');
    d.dataset.uid = p.uid;
    d.draggable = true;
    d._mw = 130; d._mh = 170;
    d.innerHTML = `<div class="frame"><canvas></canvas></div><div class="lbl">${i + 1}${p.annots.length ? ' · edited' : ''}</div><div class="tick">✓</div>${multiSrc ? `<div class="src" title="${S.sources.get(p.src).name}">File ${srcIdx.get(p.src)}</div>` : ''}`;
    g.appendChild(d);
    thumbObs.observe(d);
  });
  updateSelCount();
}
function updateSelCount() {
  $('#selCount').textContent = `${S.sel.size} of ${S.pages.length} selected`;
  $('#selAll').checked = S.sel.size && S.sel.size === S.pages.length;
}
$('#orgGrid').addEventListener('click', (e) => {
  const d = e.target.closest('.org-page');
  if (!d) return;
  const u = d.dataset.uid;
  const idx = S.pages.findIndex((p) => p.uid === u);
  if (e.shiftKey && S.lastSel != null) {
    const a = S.pages.findIndex((p) => p.uid === S.lastSel);
    const [lo, hi] = a < idx ? [a, idx] : [idx, a];
    for (let i = lo; i <= hi; i++) S.sel.add(S.pages[i].uid);
  } else if (S.sel.has(u)) S.sel.delete(u);
  else S.sel.add(u);
  S.lastSel = u;
  $$('.org-page', $('#orgGrid')).forEach((el) => el.classList.toggle('selected', S.sel.has(el.dataset.uid)));
  updateSelCount();
});
$('#orgGrid').addEventListener('dblclick', (e) => {
  const d = e.target.closest('.org-page');
  if (!d) return;
  const i = S.pages.findIndex((p) => p.uid === d.dataset.uid);
  setMode('edit');
  setTimeout(() => scrollToPage(i), 50);
});
$('#selAll').onchange = (e) => {
  S.sel = e.target.checked ? new Set(S.pages.map((p) => p.uid)) : new Set();
  $$('.org-page', $('#orgGrid')).forEach((el) => el.classList.toggle('selected', S.sel.has(el.dataset.uid)));
  updateSelCount();
};
// drag & drop reorder
let orgDrag = null;
$('#orgGrid').addEventListener('dragstart', (e) => {
  const d = e.target.closest('.org-page');
  if (!d) return;
  const u = d.dataset.uid;
  orgDrag = S.sel.has(u) ? S.pages.filter((p) => S.sel.has(p.uid)).map((p) => p.uid) : [u];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'pages');
  setTimeout(() => orgDrag?.forEach((x) => $(`.org-page[data-uid="${x}"]`)?.classList.add('dragging')), 0);
});
$('#orgGrid').addEventListener('dragover', (e) => {
  if (!orgDrag) return;
  e.preventDefault();
  const d = e.target.closest('.org-page');
  $$('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  if (!d) return;
  const r = d.getBoundingClientRect();
  d.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
});
$('#orgGrid').addEventListener('drop', (e) => {
  if (!orgDrag) return;
  e.preventDefault();
  e.stopPropagation();
  const d = $('.drop-before,.drop-after');
  if (d) {
    const after = d.classList.contains('drop-after');
    const target = d.dataset.uid;
    if (!orgDrag.includes(target) || true) {
      pushHistory();
      const moving = S.pages.filter((p) => orgDrag.includes(p.uid));
      const rest = S.pages.filter((p) => !orgDrag.includes(p.uid));
      let at = rest.findIndex((p) => p.uid === target);
      if (at === -1) { // dropped on one of the moving pages: keep order
        at = S.pages.findIndex((p) => p.uid === target);
        at = rest.filter((p) => S.pages.indexOf(p) < at).length;
      } else if (after) at += 1;
      rest.splice(at, 0, ...moving);
      S.pages = rest;
      rebuildAll();
    }
  }
  orgDrag = null;
});
$('#orgGrid').addEventListener('dragend', () => {
  orgDrag = null;
  $$('.dragging,.drop-before,.drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
});

function selectedPages() { return S.pages.filter((p) => S.sel.has(p.uid)); }
function needSel() { if (!S.sel.size) { toast('Select one or more pages first.'); return false; } return true; }
function rotateSel(dir) {
  if (!needSel()) return;
  pushHistory();
  S.pages = S.pages.map((p) => (S.sel.has(p.uid) ? { ...p, rot: (p.rot + dir + 360) % 360 } : p));
  rebuildAll();
}
function deleteSel() {
  if (!needSel()) return;
  if (S.sel.size >= S.pages.length) { toast('A PDF needs at least one page. Keep at least one.'); return; }
  pushHistory();
  S.pages = S.pages.filter((p) => !S.sel.has(p.uid));
  S.sel = new Set();
  S.current = Math.min(S.current, S.pages.length - 1);
  rebuildAll();
}
function duplicateSelPages() {
  if (!needSel()) return;
  pushHistory();
  const out = [];
  for (const p of S.pages) {
    out.push(p);
    if (S.sel.has(p.uid)) out.push({ ...p, uid: uid('p'), annots: p.annots.map((a) => ({ ...a, id: uid('a') })) });
  }
  S.pages = out;
  rebuildAll();
}
function insertPos() {
  if (!S.sel.size) return S.pages.length;
  let last = -1;
  S.pages.forEach((p, i) => { if (S.sel.has(p.uid)) last = i; });
  return last + 1;
}

// ------------------------------------------------------------------ saving & converting
function ctx() { return { sources: S.sources, getPage, formValues: S.formValues, fieldMeta: S.fieldMeta }; }

async function build(pages = S.pages, opts = {}) {
  document.activeElement?.blur?.();
  return buildPdf(ctx(), pages, { flattenForms: $('#flattenForms').checked, ...opts });
}

async function savePdf() {
  if (!S.pages.length) return;
  busy('Saving PDF…');
  try {
    const bytes = await build();
    busy(false);
    const res = await io.saveFile(baseName() + (S.dirty ? '-edited' : '') + '.pdf', bytes);
    if (res) {
      S.dirty = false; io.setDirty(false); updateButtons();
      toast(`Saved (${fmtBytes(bytes.length)}).`, typeof res === 'string' ? { action: { label: 'Show in folder', run: () => io.showInFolder(res) } } : {});
    }
  } catch (e) {
    console.error(e);
    toast('Saving failed: ' + (e.message || e), { err: true, ms: 8000 });
  } finally { busy(false); }
}

async function extractSel() {
  if (!needSel()) return;
  busy('Extracting pages…');
  try {
    const bytes = await build(selectedPages());
    busy(false);
    const res = await io.saveFile(`${baseName()}-pages.pdf`, bytes);
    if (res) toast(`Saved ${S.sel.size} page${S.sel.size > 1 ? 's' : ''} as a new PDF.`);
  } catch (e) { console.error(e); toast('Extract failed: ' + e.message, { err: true }); } finally { busy(false); }
}

function parseRanges(str, n) {
  const parts = str.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)\s*(?:-|–|to)\s*(\d+|end)$/i) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`“${part}” isn't a valid range`);
    const a = +m[1], b = m[2] ? (m[2].toLowerCase() === 'end' ? n : +m[2]) : a;
    if (a < 1 || b > n || a > b) throw new Error(`“${part}” is outside 1–${n}`);
    out.push([a, b]);
  }
  if (!out.length) throw new Error('Type at least one range');
  return out;
}
function openSplit() {
  if (!S.pages.length) return;
  $('#splitInfo').textContent = `This document has ${S.pages.length} pages.`;
  $('#splitModal').classList.remove('hidden');
}
async function doSplit() {
  const mode = $('input[name=splitMode]:checked').value;
  let groups;
  try {
    groups = mode === 'each' ? S.pages.map((_, i) => [i + 1, i + 1]) : parseRanges($('#splitRanges').value, S.pages.length);
  } catch (e) { toast(e.message, { err: true }); return; }
  closeModals();
  busy('Splitting…');
  try {
    const files = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const [a, b] = groups[gi];
      busy(`Splitting… ${gi + 1}/${groups.length}`);
      const bytes = await build(S.pages.slice(a - 1, b));
      files.push({ name: `${baseName()}-${a === b ? 'page-' + a : `pages-${a}-${b}`}.pdf`, bytes });
    }
    busy(false);
    const res = await io.saveMany(files, `${baseName()}-split.zip`);
    if (res) toast(io.isDesktop ? `Saved ${files.length} PDF files.` : `Saved ${files.length} PDFs in one .zip file.`, typeof res === 'string' ? { action: { label: 'Open folder', run: () => io.showInFolder(res + '/' + files[0].name) } } : {});
  } catch (e) { console.error(e); toast('Split failed: ' + e.message, { err: true }); } finally { busy(false); }
}

async function exportImages() {
  if (!S.pages.length) return;
  const selOnly = $('#imgSelOnly').checked && S.sel.size;
  const pages = selOnly ? selectedPages() : S.pages;
  const fmt = $('#imgFmt').value, dpi = +$('#imgDpi').value;
  busy('Rendering pages…');
  try {
    const bytes = await build(pages);
    const doc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes }).promise;
    const files = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`Rendering page ${i} of ${doc.numPages}…`);
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92));
      const n = S.pages.indexOf(pages[i - 1]) + 1;
      files.push({ name: `${baseName()}-page-${n}.${fmt}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      c.width = c.height = 0;
    }
    doc.destroy();
    busy(false);
    const res = files.length === 1 ? await io.saveFile(files[0].name, files[0].bytes) : await io.saveMany(files, `${baseName()}-images.zip`);
    if (res) toast(`Exported ${files.length} image${files.length > 1 ? 's' : ''}.`);
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, { err: true }); } finally { busy(false); }
}

async function exportText() {
  if (!S.pages.length) return;
  busy('Extracting text…');
  try {
    const chunks = [];
    for (let i = 0; i < S.pages.length; i++) {
      const p = S.pages[i];
      const tc = await getText(p.src, p.idx);
      let s = '';
      for (const it of tc.items) { s += it.str; if (it.hasEOL) s += '\n'; else if (it.str && !/\s$/.test(it.str)) s += ''; }
      const added = p.annots.filter((a) => a.type === 'text' && a.text).map((a) => a.text);
      chunks.push(`--- Page ${i + 1} ---\n${s.trim()}${added.length ? '\n' + added.join('\n') : ''}`);
    }
    busy(false);
    const res = await io.saveFile(`${baseName()}.txt`, new TextEncoder().encode(chunks.join('\n\n') + '\n'));
    if (res) toast('Text exported.');
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, { err: true }); } finally { busy(false); }
}

async function compress() {
  if (!S.pages.length) return;
  const level = $('#cmpLevel').value;
  const origSize = [...new Set(S.pages.map((p) => p.src))].reduce((n, id) => n + S.sources.get(id).bytes.length, 0);
  busy('Compressing…');
  try {
    let bytes = await build();
    if (level === 'light') bytes = await optimizePdf(bytes);
    else {
      const doc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
      const [dpi, q] = level === 'medium' ? [150, 0.72] : [96, 0.6];
      bytes = await rasterizePdf(doc, dpi, q, (i, n) => busy(`Compressing page ${i} of ${n}…`));
      doc.destroy();
    }
    busy(false);
    const pct = Math.round((1 - bytes.length / origSize) * 100);
    if (bytes.length >= origSize) {
      const go = await ask({ title: 'Already small', message: `The compressed file (${fmtBytes(bytes.length)}) isn't smaller than the original (${fmtBytes(origSize)}). Save it anyway?`, ok: 'Save anyway' });
      if (!go) return;
    }
    const res = await io.saveFile(`${baseName()}-compressed.pdf`, bytes);
    if (res) toast(`Saved: ${fmtBytes(origSize)} → ${fmtBytes(bytes.length)}${pct > 0 ? ` (${pct}% smaller)` : ''}.`, { ms: 7000 });
  } catch (e) { console.error(e); toast('Compression failed: ' + e.message, { err: true }); } finally { busy(false); }
}

async function imagesFlow({ insert = false } = {}) {
  const imgs = await io.pickImages(true);
  if (!imgs.length) return;
  busy('Building PDF from images…');
  try {
    const opts = insert ? { size: 'fit', margin: 0 } : { size: $('#i2pSize').value, margin: +$('#i2pMargin').value };
    if (insert && S.pages.length) {
      const d = dispSize(S.pages[S.current] || S.pages[0]);
      Object.assign(opts, { size: d.w > d.h ? 'a4' : 'a4', margin: 24 });
    }
    const bytes = await imagesToPdf(imgs, opts);
    busy(false);
    if (insert && S.pages.length) await addGeneratedSource('Images.pdf', bytes, { append: true, at: insertPos() });
    else { await openEntries([{ name: 'Images.pdf', bytes }]); S.dirty = true; io.setDirty(true); updateButtons(); toast(`Created a ${imgs.length}-page PDF. Click Save PDF to keep it.`); }
  } catch (e) { console.error(e); toast("Couldn't read one of the images: " + e.message, { err: true }); } finally { busy(false); }
}

async function mergeFlow() {
  const files = await io.pickPdfs(true);
  if (!files.length) return;
  if (S.pages.length) await openEntries(files, { append: true });
  else await openEntries(files);
  setMode('pages');
  if (files.length > 1 || S.sources.size > 1) toast('Merged. Drag pages to reorder, then Save PDF.');
}

async function insertBlank() {
  const ref = S.pages[Math.max(0, insertPos() - 1)] || S.pages[0];
  const bytes = await blankPdf(ref ? ref.w0 : 595.28, ref ? ref.h0 : 841.89);
  await addGeneratedSource('Blank page.pdf', bytes, { append: true, at: insertPos() });
}

// ------------------------------------------------------------------ modes / chrome
function setMode(m) {
  S.mode = m;
  $$('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $$('.mode-view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + m));
  $('.zoom').style.visibility = m === 'edit' ? 'visible' : 'hidden';
  if (m === 'pages') rebuildOrg();
}
function updateButtons() {
  const has = S.pages.length > 0;
  $('[data-action=save]').disabled = !has;
  $('[data-action=undo]').disabled = !S.undo.length;
  $('[data-action=redo]').disabled = !S.redo.length;
  $$('[data-needs-doc]').forEach((b) => (b.disabled = !has));
  document.title = (S.dirty ? '• ' : '') + (S.docName ? S.docName + ' — ' : '') + 'Harit PDF';
}
function updateStatus() {
  $('#docName').textContent = S.pages.length ? `${S.docName}${S.dirty ? ' (unsaved changes)' : ''}` : 'No file open';
  $('#pageInfo').textContent = S.pages.length ? `Page ${S.current + 1} of ${S.pages.length}` : '';
}

const actions = {
  open: async () => { const f = await io.pickPdfs(false); if (f.length) { await openEntries(f); setMode('edit'); } },
  save: savePdf,
  undo, redo,
  'zoom-in': () => setZoom(S.zoom * 1.2),
  'zoom-out': () => setZoom(S.zoom / 1.2),
  'zoom-fit': () => fitWidth(true),
  merge: mergeFlow,
  img2pdf: () => imagesFlow(),
  'export-images': exportImages,
  'export-text': exportText,
  compress,
  split: openSplit,
  'split-go': doSplit,
  'rot-left': () => rotateSel(-90),
  'rot-right': () => rotateSel(90),
  'del-pages': deleteSel,
  'dup-pages': duplicateSelPages,
  'insert-pdf': async () => { const f = await io.pickPdfs(true); if (f.length) await openEntries(f, { append: true, at: insertPos() }); },
  'insert-img': () => imagesFlow({ insert: true }),
  'insert-blank': insertBlank,
  extract: extractSel,
  'close-modal': closeModals,
  'sig-clear': () => { sig.strokes = []; drawSigPad(); },
  'sig-use': useSignature,
  'sig-upload': sigUpload,
  'del-sel': () => S.selAnn && removeAnn(S.selAnn.id),
  'dup-sel': duplicateSel,
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (b && !b.disabled && actions[b.dataset.action]) actions[b.dataset.action]();
  const t = e.target.closest('.tool');
  if (t) setTool(t.dataset.tool);
  const m = e.target.closest('.mode');
  if (m) setMode(m.dataset.mode);
});
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); }));
$$('input[name=splitMode]').forEach((r) => r.onchange = () => { if (r.value === 'ranges') $('#splitRanges').focus(); });
$('#splitRanges').addEventListener('focus', () => { $('input[name=splitMode][value=ranges]').checked = true; });

// keyboard
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable=true], [contenteditable=plaintext-only]');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); actions.open(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); savePdf(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(S.zoom * 1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(S.zoom / 1.2); return; }
  if (mod && e.key.toLowerCase() === 'd' && S.selAnn) { e.preventDefault(); duplicateSel(); return; }
  if (mod && e.key.toLowerCase() === 'a' && S.mode === 'pages') { e.preventDefault(); $('#selAll').checked = true; $('#selAll').onchange({ target: $('#selAll') }); return; }
  if (e.key === 'Escape') { closeModals(); selectAnn(null, null); if (S.tool !== 'select') setTool('select'); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace')) {
    if (S.mode === 'edit' && S.selAnn) { e.preventDefault(); removeAnn(S.selAnn.id); }
    else if (S.mode === 'pages' && S.sel.size) { e.preventDefault(); deleteSel(); }
    return;
  }
  if (S.selAnn && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const f = findAnn(S.selAnn.id);
    if (!f) return;
    const step = e.shiftKey ? 10 : 1;
    const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    pushHistory();
    const { dx, dy } = vecToAnn(f.p, f.a, v[0], v[1]);
    f.a.x += dx; f.a.y += dy;
    styleAnnEl(f.p, f.a, $(`.ann[data-id="${f.a.id}"]`));
    return;
  }
  if (S.mode !== 'edit' || mod || e.altKey) return;
  const map = { v: 'select', e: 'edittext', t: 'text', h: 'highlight', d: 'draw', r: 'rect', w: 'whiteout', i: 'image', s: 'sign', f: 'forms' };
  const t = map[e.key.toLowerCase()];
  if (t) setTool(t);
});

// file drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => /^image\//.test(f.type));
  const pdfEntries = await Promise.all(pdfs.map(io.fileToEntry));
  const imgEntries = await Promise.all(imgs.map(io.fileToEntry));
  if (pdfEntries.length) {
    if (S.mode === 'pages' && S.pages.length) await openEntries(pdfEntries, { append: true, at: insertPos() });
    else { await openEntries(pdfEntries); }
  } else if (imgEntries.length) {
    if (S.pages.length && S.mode === 'edit') {
      const { url, w, h } = await fileToDataUrl(imgEntries[0]);
      placeImage(url, w, h, 0.5);
    } else {
      const bytes = await imagesToPdf(imgEntries, { size: $('#i2pSize').value, margin: +$('#i2pMargin').value });
      if (S.pages.length) await addGeneratedSource('Images.pdf', bytes, { append: true, at: insertPos() });
      else { await openEntries([{ name: 'Images.pdf', bytes }]); S.dirty = true; updateButtons(); }
    }
  }
});

window.addEventListener('resize', () => { /* keep zoom; nothing to do */ });

// ------------------------------------------------------------------ init
hydrateIcons();
if (!io.isDesktop) {
  $('.drop-card p').textContent = 'Edit text, sign, highlight, fill forms, organise pages and convert, right here in your browser.';
  $('.drop-card .tiny').textContent = 'Your files are processed on your device and never uploaded.';
}
buildSwatches();
updateProps();
updateButtons();
io.onOpenPaths((entries) => openEntries(entries));
io.pendingFiles().then((entries) => { if (entries.length) openEntries(entries); });

// test hook
window.__haritPdf = { S, build, openEntries, setTool, setMode, rebuildAll };

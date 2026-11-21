// Turns the editor state (page list + annotations + form values) into a real PDF using pdf-lib.
const {
  PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  PDFName, PDFArray, PDFRef,
} = window.PDFLib;
const fontkit = window.fontkit;

export const BASELINE = { Helvetica: 0.93, Times: 0.91, Courier: 0.86 };
export const LINE_H = 1.15;

let uniFontBytes = null;
async function uniBytes(bold) {
  if (!uniFontBytes) uniFontBytes = {};
  const k = bold ? 'b' : 'r';
  if (!uniFontBytes[k]) {
    const r = await fetch(bold ? 'DejaVuSans-Bold.ttf' : 'DejaVuSans.ttf');
    uniFontBytes[k] = new Uint8Array(await r.arrayBuffer());
  }
  return uniFontBytes[k];
}

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataUrlBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class FontCache {
  constructor(doc) { this.doc = doc; this.map = new Map(); }
  async get(family, bold, text) {
    const std = {
      Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
      Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
      Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
    }[family] || [StandardFonts.Helvetica, StandardFonts.HelveticaBold];
    const name = std[bold ? 1 : 0];
    if (!this.map.has(name)) this.map.set(name, await this.doc.embedFont(name));
    const f = this.map.get(name);
    try { f.encodeText(text.replace(/[\r\n]/g, '')); return f; } catch { /* needs unicode font */ }
    const uk = bold ? 'uni-b' : 'uni';
    if (!this.map.has(uk)) this.map.set(uk, await this.doc.embedFont(await uniBytes(bold), { subset: true }));
    return this.map.get(uk);
  }
}

function needsUnicode(s) { return /[^\x00-\x7E -ÿ]/.test(s); }

/** Write form values into a pdf-lib document. Returns true if the doc has form fields. */
async function applyForms(doc, srcId, ctx, flatten) {
  let form;
  try { form = doc.getForm(); } catch { return false; }
  let fields;
  try { fields = form.getFields(); } catch { return false; }
  if (!fields.length) return false;
  let uni = false;
  for (const [key, val] of ctx.formValues) {
    if (!key.startsWith(srcId + '|')) continue;
    const name = key.slice(srcId.length + 1);
    const meta = ctx.fieldMeta.get(key) || {};
    try {
      const f = form.getField(name);
      if (f instanceof PDFTextField) {
        const s = String(val ?? '');
        if (needsUnicode(s)) uni = true;
        try { f.setText(s); } catch { f.disableMaxLength?.(); f.setText(s); }
      } else if (f instanceof PDFCheckBox) {
        val ? f.check() : f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        if (!val) { f.clear(); continue; }
        const opts = f.getOptions();
        const v = String(val);
        if (opts.includes(v)) f.select(v);
        else if (/^\d+$/.test(v) && opts[+v] != null) f.select(opts[+v]); // pdf.js reports /Opt indices
        else f.select(v);
      } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (val == null || val === '') { f.clear(); continue; }
        try { f.select(String(val)); } catch {
          const opt = (meta.options || []).find((o) => o.exportValue === val);
          f.select(opt ? opt.displayValue : String(val));
        }
      }
    } catch (e) { console.warn('form field', name, e); }
  }
  if (uni) {
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await uniBytes(false), { subset: false });
    try { form.updateFieldAppearances(font); } catch (e) { console.warn(e); }
  }
  if (flatten) {
    try { form.flatten({ updateFieldAppearances: !uni }); } catch (e) { console.warn('flatten failed', e); }
    pruneDanglingAnnots(doc);
  }
  return true;
}

/** pdf-lib's flatten can leave page /Annots pointing at deleted widgets; remove those refs. */
function pruneDanglingAnnots(doc) {
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const r = annots.get(i);
      if (r instanceof PDFRef && !doc.context.lookup(r)) annots.remove(i);
    }
  }
}

/** Render pages of a source that pdf-lib can't edit (encrypted / damaged) into image pages. */
async function rasterPages(out, ctx, src, idxs) {
  const pages = [];
  for (const idx of idxs) {
    const pj = await ctx.getPage(src.id, idx);
    const vp0 = pj.getViewport({ scale: 1, rotation: 0 });
    const scale = 200 / 72;
    const vp = pj.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const c2d = canvas.getContext('2d');
    c2d.fillStyle = '#fff'; c2d.fillRect(0, 0, canvas.width, canvas.height);
    await pj.render({ canvasContext: c2d, viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const [x0, y0] = pj.view;
    const page = out.addPage([vp0.width, vp0.height]);
    out.removePage(out.getPageCount() - 1); // created detached; we add it in order later
    page.setMediaBox(x0, y0, vp0.width, vp0.height);
    page.drawImage(img, { x: x0, y: y0, width: vp0.width, height: vp0.height });
    pages.push(page);
  }
  return pages;
}

async function drawAnn(doc, page, pj, a, fonts) {
  const vp = pj.getViewport({ scale: 1, rotation: a.rot || 0 });
  const conv = (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; };
  const rotate = degrees(a.rot || 0);

  if (a.type === 'highlight' || a.type === 'whiteout' || a.type === 'rect') {
    const o = conv(a.x, a.y + a.h);
    const opts = { x: o.x, y: o.y, width: a.w, height: a.h, rotate };
    if (a.type === 'highlight') Object.assign(opts, { color: hexToRgb(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
    else if (a.type === 'whiteout') Object.assign(opts, { color: hexToRgb(a.color || '#ffffff') });
    else {
      if (a.fill) Object.assign(opts, { color: hexToRgb(a.color) });
      else {
        // inset so the stroke stays inside the box like on screen
        const s = a.stroke;
        const o2 = conv(a.x + s / 2, a.y + a.h - s / 2);
        Object.assign(opts, { x: o2.x, y: o2.y, width: Math.max(0.1, a.w - s), height: Math.max(0.1, a.h - s), borderColor: hexToRgb(a.color), borderWidth: s });
      }
    }
    page.drawRectangle(opts);
  } else if (a.type === 'text') {
    const lines = String(a.text || '').split('\n');
    const font = await fonts.get(a.font, a.bold, a.text || ' ');
    lines.forEach((line, i) => {
      if (!line) return;
      const o = conv(a.x, a.y + (BASELINE[a.font] || 0.93) * a.size + i * LINE_H * a.size);
      page.drawText(line, { x: o.x, y: o.y, size: a.size, font, color: hexToRgb(a.color), rotate });
    });
  } else if (a.type === 'image') {
    const bytes = dataUrlBytes(a.src);
    const img = a.src.startsWith('data:image/jpeg') ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const o = conv(a.x, a.y + a.h);
    page.drawImage(img, { x: o.x, y: o.y, width: a.w, height: a.h, rotate });
  } else if (a.type === 'ink') {
    const sx = a.w / a.w0, sy = a.h / a.h0;
    const pts = a.points;
    if (!pts.length) return;
    let d = `M ${pts[0][0] * sx} ${pts[0][1] * sy}`;
    if (pts.length === 1) d += ` L ${pts[0][0] * sx + 0.01} ${pts[0][1] * sy}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0] * sx} ${pts[i][1] * sy}`;
    const o = conv(a.x, a.y);
    page.drawSvgPath(d, {
      x: o.x, y: o.y, rotate, borderColor: hexToRgb(a.color),
      borderWidth: a.stroke * Math.sqrt(sx * sy), borderLineCap: LineCapStyle.Round,
    });
  }
}

/**
 * ctx: { sources: Map, getPage(srcId, idx), formValues: Map, fieldMeta: Map }
 * pageList: [{ src, idx, rot, baseRot, annots }]
 */
export async function buildPdf(ctx, pageList, { flattenForms = false } = {}) {
  const used = [...new Set(pageList.map((p) => p.src))];
  let out, outPages;

  if (used.length === 1 && !ctx.sources.get(used[0]).raster) {
    const src = ctx.sources.get(used[0]);
    out = await PDFDocument.load(src.bytes, { updateMetadata: false });
    out.registerFontkit(fontkit);
    await applyForms(out, src.id, ctx, flattenForms);
    const orig = out.getPages();
    const seen = new Set();
    outPages = [];
    for (const p of pageList) {
      if (seen.has(p.idx)) { const [cp] = await out.copyPages(out, [p.idx]); outPages.push(cp); }
      else { seen.add(p.idx); outPages.push(orig[p.idx]); }
    }
    for (let i = orig.length - 1; i >= 0; i--) out.removePage(i);
    outPages.forEach((pg) => out.addPage(pg));
  } else {
    out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const copied = new Map();
    for (const id of used) {
      const src = ctx.sources.get(id);
      const idxs = pageList.filter((p) => p.src === id).map((p) => p.idx);
      if (src.raster) {
        copied.set(id, await rasterPages(out, ctx, src, idxs));
      } else {
        const sdoc = await PDFDocument.load(src.bytes, { updateMetadata: false });
        await applyForms(sdoc, id, ctx, true);
        copied.set(id, await out.copyPages(sdoc, idxs));
      }
    }
    const counters = new Map();
    outPages = pageList.map((p) => {
      const i = counters.get(p.src) || 0;
      counters.set(p.src, i + 1);
      return copied.get(p.src)[i];
    });
    outPages.forEach((pg) => out.addPage(pg));
  }

  const fonts = new FontCache(out);
  for (let i = 0; i < pageList.length; i++) {
    const p = pageList[i];
    const pg = outPages[i];
    pg.setRotation(degrees(((p.baseRot + p.rot) % 360 + 360) % 360));
    if (p.annots.length) {
      const pj = await ctx.getPage(p.src, p.idx);
      for (const a of p.annots) await drawAnn(out, pg, pj, a, fonts);
    }
  }
  out.setProducer('Harit PDF');
  return out.save();
}

/** Create a PDF from images. imgs: [{bytes, type, name}] */
export async function imagesToPdf(imgs, { size = 'fit', margin = 0 } = {}) {
  const doc = await PDFDocument.create();
  for (const im of imgs) {
    const blob = new Blob([im.bytes], { type: im.type || guessType(im.name) });
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const max = 4000;
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cw = Math.round(bmp.width * k), ch = Math.round(bmp.height * k);
    const isPng = /png|gif/.test(blob.type) || /\.png$|\.gif$/i.test(im.name || '');
    let embedded;
    if (isPng && k === 1 && /png/.test(blob.type)) {
      embedded = await doc.embedPng(im.bytes);
    } else {
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d');
      if (!isPng) { g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); }
      g.drawImage(bmp, 0, 0, cw, ch);
      const out = await new Promise((r) => c.toBlob(r, isPng ? 'image/png' : 'image/jpeg', 0.92));
      const b = new Uint8Array(await out.arrayBuffer());
      embedded = isPng ? await doc.embedPng(b) : await doc.embedJpg(b);
    }
    bmp.close?.();
    let pw, ph;
    const landscape = cw > ch;
    if (size === 'a4') [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
    else if (size === 'letter') [pw, ph] = landscape ? [792, 612] : [612, 792];
    else {
      let s = 0.75; // px -> pt at 96 dpi
      const long = Math.max(cw, ch) * s;
      if (long > 1400) s *= 1400 / long;
      pw = cw * s + margin * 2; ph = ch * s + margin * 2;
    }
    const aw = pw - margin * 2, ah = ph - margin * 2;
    const f = Math.min(aw / cw, ah / ch);
    const w = cw * f, h = ch * f;
    const page = doc.addPage([pw, ph]);
    page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  doc.setProducer('Harit PDF');
  return doc.save();
}

export async function blankPdf(w = 595.28, h = 841.89) {
  const doc = await PDFDocument.create();
  doc.addPage([w, h]);
  return doc.save();
}

/** Rebuild a PDF as images (strong compression). pj: pdf.js document */
export async function rasterizePdf(pjDoc, dpi, quality, onProgress) {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pjDoc.numPages; i++) {
    onProgress?.(i, pjDoc.numPages);
    const page = await pjDoc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const p = doc.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    c.width = c.height = 0;
  }
  doc.setProducer('Harit PDF');
  return doc.save();
}

export async function optimizePdf(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.save({ useObjectStreams: true });
}

export async function canEdit(bytes) {
  try { await PDFDocument.load(bytes, { updateMetadata: false }); return true; } catch { return false; }
}

function guessType(name = '') {
  const e = name.split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[e] || 'image/png';
}

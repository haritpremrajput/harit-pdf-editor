// Simple stroke icons (24x24, original drawings)
const P = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="8" rx="1"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 6l3 3"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  convert: '<path d="M4 9h13l-3-3"/><path d="M20 15H7l3 3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  minus: '<path d="M6 12h12"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  cursor: '<path d="M6 3l12 9-5.5 1.2L15 20l-2.6 1.2-2.6-6.6L6 18z"/>',
  edittext: '<path d="M4 6V4h12v2"/><path d="M10 4v13"/><path d="M8 17h4"/><path d="M14 20l1-3 5-5 2 2-5 5z"/>',
  text: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  highlight: '<path d="M9 14l-3 3v3h3l3-3"/><path d="M9 14l7-9 4 4-9 7z"/><path d="M3 21h18" opacity=".5"/>',
  draw: '<path d="M3 17c3-6 5 3 8-3s4-8 7-4 1 9 3 7"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  eraser: '<path d="M7 20h13"/><path d="M4 15l9-9 6 6-7 7H8z"/><path d="M9 10l6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  sign: '<path d="M3 17c2-1 3-6 5-6s0 6 2 6 2-4 4-4 1 3 3 3 2-2 4-2"/><path d="M3 21h18"/>',
  form: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8"/><rect x="8" y="15" width="3" height="3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  file: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  merge: '<path d="M7 4v5a5 5 0 0 0 5 5 5 5 0 0 1 5 5v1"/><path d="M17 4v5a5 5 0 0 1-3 4.6"/><path d="M4 7l3-3 3 3M14 7l3-3 3 3"/>',
  rotl: '<path d="M4 4v5h5"/><path d="M4.5 13A8 8 0 1 0 6 6.5L4 9"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M19.5 13A8 8 0 1 1 18 6.5L20 9"/>',
  extract: '<path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 10v7M9 14l3 3 3-3"/>',
  split: '<path d="M5 3h5v18H5zM14 3h5v18h-5z"/>',
  compress: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = iconSvg(el.dataset.icon);
  });
}

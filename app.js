'use strict';

// Recognition language, as a Google Input Tools code ('en', 'hi', 'de', 'fr', ...).
const LANG = 'en';
// How long the pen has to rest before handwriting turns into text.
const CONVERT_DELAY = 900;
const RECOGNIZER = 'https://inputtools.google.com/request?ime=handwriting&app=inkboard&cs=1&oe=UTF-8';

const FONT = 'Excalifont';
const LINE_HEIGHT = 1.25;
// Write ink is only there until it turns into text; Draw ink and arrows take the toolbar's width.
const WRITE_WIDTH = 2.5;
// Each side of an arrowhead leans this far off the shaft.
const ARROW_HEAD_ANGLE = Math.PI / 7;
const ERASER_RADIUS = 10;
const HANDLE_SIZE = 8;
const RESIZE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', start: 'move', end: 'move' };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const STORAGE_KEY = 'inkboard:v1';
// Pasted pictures live in IndexedDB, which has room for them, keyed by fileId.
const FILES_DB = 'inkboard';
const CLIPBOARD_TYPE = 'application/x-inkboard';
// The board is inverted in dark mode; pictures are drawn pre-inverted so they look as pasted.
const IMAGE_INVERT_FILTER = 'invert(100%) hue-rotate(180deg)';

const $ = (s) => document.querySelector(s);
const canvas = $('#board');
const ctx = canvas.getContext('2d');
const measureCtx = document.createElement('canvas').getContext('2d');
const editor = $('#editor');
const candidatesBox = $('#candidates');

const state = {
  tool: 'write',
  color: '#1e1e1e',
  width: 4,
  view: { x: 0, y: 0, zoom: 1 }, // screen = world * zoom + (x, y)
  elements: [],
  selectedIds: [],
};

let dpr = 1;
let W = 0;
let H = 0;
let undoStack = [];
let redoStack = [];
let pendingIds = [];      // write strokes waiting to be recognized
let convertTimer = null;
let inflight = 0;
let pointer = null;       // the gesture in progress
let hover = null;         // last pointer position on screen, for the eraser ring
let spaceDown = false;
let editing = null;       // { id, snap }
let candidateFor = null;  // { textId, strokes, cands }
let taps = [];            // { id, snap, at } of Write strokes that were just a click
let fontRatios = null;
const files = new Map();  // fileId -> { src, img }, kept out of the undo history

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const byId = (id) => state.elements.find((el) => el.id === id);
const selection = () => state.selectedIds.map(byId).filter(Boolean);
const isSelected = (id) => state.selectedIds.includes(id);
const toWorld = (sx, sy) => ({
  x: (sx - state.view.x) / state.view.zoom,
  y: (sy - state.view.y) / state.view.zoom,
});
const toScreen = (wx, wy) => ({
  x: wx * state.view.zoom + state.view.x,
  y: wy * state.view.zoom + state.view.y,
});
// Ink and arrows are point lists; texts and pictures are boxes.
const hasPts = (el) => el.type === 'ink' || el.type === 'arrow';

/* ---------- geometry ---------- */

const fontStr = (size) => `${size}px ${FONT}`;

function metrics() {
  if (!fontRatios) {
    measureCtx.font = fontStr(100);
    const m = measureCtx.measureText('Hg');
    fontRatios = { asc: m.fontBoundingBoxAscent / 100, desc: m.fontBoundingBoxDescent / 100 };
  }
  return fontRatios;
}

// Distance from the top of a text line to its baseline, laid out the way CSS
// line-height does it, so the canvas text and the edit box line up.
function baselineOffset(size) {
  const { asc, desc } = metrics();
  return (LINE_HEIGHT - asc - desc) * size / 2 + asc * size;
}

function textBounds(el) {
  measureCtx.font = fontStr(el.size);
  const lines = el.text.split('\n');
  const w = Math.max(el.size * 0.3, ...lines.map((l) => measureCtx.measureText(l).width));
  return { x: el.x, y: el.y, w, h: lines.length * LINE_HEIGHT * el.size };
}

function inkBounds(el, padded = true) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of el.pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const p = padded ? el.width / 2 : 0;
  return { x: x0 - p, y: y0 - p, w: x1 - x0 + 2 * p, h: y1 - y0 + 2 * p };
}

// The two ends of an arrowhead's sides; they meet the shaft at its tip, pts[1].
function arrowHead(el) {
  const [[x0, y0], [x1, y1]] = el.pts;
  const h = Math.min(Math.hypot(x1 - x0, y1 - y0) * 0.4, 8 + el.width * 3.5);
  const a = Math.atan2(y1 - y0, x1 - x0);
  return [-1, 1].map((s) => [x1 - h * Math.cos(a + s * ARROW_HEAD_ANGLE), y1 - h * Math.sin(a + s * ARROW_HEAD_ANGLE)]);
}

function arrowSegments(el) {
  const [start, tip] = el.pts;
  return [[start, tip], ...arrowHead(el).map((p) => [p, tip])];
}

function bounds(el, padded = true) {
  if (el.type === 'text') return textBounds(el);
  if (el.type === 'image') return { x: el.x, y: el.y, w: el.w, h: el.h };
  // Padded for the sloppy lines too (see sketchLine)
  if (el.type === 'arrow') return inkBounds({ pts: [...el.pts, ...arrowHead(el)], width: el.width * 2 + 16 }, padded);
  return inkBounds(el, padded);
}

function unionBounds(list, padded = true) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of list) {
    const b = bounds(el, padded);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const intersects = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(el, x, y, r) {
  if (el.type === 'arrow') {
    r += el.width / 2;
    return arrowSegments(el).some(([a, b]) => distToSegment(x, y, a[0], a[1], b[0], b[1]) <= r);
  }
  if (el.type !== 'ink') {
    const b = bounds(el);
    return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
  }
  r += el.width / 2;
  const b = inkBounds(el);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  const p = el.pts;
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= r;
  for (let i = 1; i < p.length; i++) {
    if (distToSegment(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
  }
  return false;
}

function hitTest(x, y) {
  const tol = 6 / state.view.zoom;
  for (let i = state.elements.length - 1; i >= 0; i--) {
    if (hits(state.elements[i], x, y, tol)) return state.elements[i];
  }
  return null;
}

function selectionBox(list) {
  const b = unionBounds(list);
  const pad = 6 / state.view.zoom;
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

const corners = (b) => ({
  nw: [b.x, b.y],
  ne: [b.x + b.w, b.y],
  sw: [b.x, b.y + b.h],
  se: [b.x + b.w, b.y + b.h],
});

const loneArrow = (sel) => (sel.length === 1 && sel[0].type === 'arrow' ? sel[0] : null);

// A lone arrow is changed by dragging its ends; anything else by the corners of its box.
function handles(sel) {
  const arrow = loneArrow(sel);
  return arrow ? { start: arrow.pts[0], end: arrow.pts[1] } : corners(selectionBox(sel));
}

// Which resize handle of the selection is under the pointer, if any.
function handleAt(sx, sy) {
  const sel = selection();
  if (!sel.length || state.tool !== 'select' || editing) return null;
  for (const [name, [x, y]] of Object.entries(handles(sel))) {
    const p = toScreen(x, y);
    if (Math.abs(sx - p.x) <= HANDLE_SIZE && Math.abs(sy - p.y) <= HANDLE_SIZE) return name;
  }
  return null;
}

// Scales the selection uniformly, keeping the corner opposite the dragged one fixed.
function resizeSelection(p, w) {
  const { box, origs, corner } = p;
  const dx = corner.includes('e') ? 1 : -1;
  const dy = corner.includes('s') ? 1 : -1;
  const ax = dx > 0 ? box.x : box.x + box.w;
  const ay = dy > 0 ? box.y : box.y + box.h;
  const rx = box.w > 0.01 ? ((w.x - ax) * dx) / box.w : -Infinity;
  const ry = box.h > 0.01 ? ((w.y - ay) * dy) / box.h : -Infinity;
  if (!Number.isFinite(Math.max(rx, ry))) return;
  const s = Math.max(rx, ry, 4 / state.view.zoom / Math.max(box.w, box.h));
  for (const orig of origs) {
    const el = byId(orig.id);
    if (!el) continue;
    if (hasPts(el)) {
      el.pts = orig.pts.map(([x, y, ...rest]) => [round2(ax + (x - ax) * s), round2(ay + (y - ay) * s), ...rest]);
      continue;
    }
    el.x = ax + (orig.x - ax) * s;
    el.y = ay + (orig.y - ay) * s;
    if (el.type === 'text') {
      el.size = orig.size * s;
    } else {
      el.w = orig.w * s;
      el.h = orig.h * s;
    }
  }
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Elements mostly inside a loop drawn around them; a rough circle that clips
// a corner still counts.
function lassoPick(poly) {
  if (poly.length < 3) return [];
  return state.elements.filter((el) => {
    let samples;
    if (el.type === 'ink') {
      samples = el.pts;
    } else if (el.type === 'arrow') {
      samples = resample(el.pts, 9);
    } else {
      const b = bounds(el);
      samples = [0, 0.5, 1].flatMap((fx) => [0, 0.5, 1].map((fy) => [b.x + b.w * fx, b.y + b.h * fy]));
    }
    const inside = samples.filter(([x, y]) => insidePolygon(x, y, poly)).length;
    return inside >= samples.length * 0.6;
  }).map((el) => el.id);
}

function moveElement(el, dx, dy) {
  if (hasPts(el)) {
    for (const p of el.pts) {
      p[0] = round2(p[0] + dx);
      p[1] = round2(p[1] + dy);
    }
  } else {
    el.x += dx;
    el.y += dy;
  }
}

/* ---------- rendering ---------- */

let renderQueued = false;
function render() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(draw);
  }
}

function drawInk(c, el) {
  const p = el.pts;
  c.strokeStyle = el.color;
  c.lineWidth = el.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(p[0][0], p[0][1]);
  if (p.length < 3) {
    const last = p[p.length - 1];
    c.lineTo(last[0] + 0.01, last[1]);
  } else {
    // Curve through the midpoints so mouse jitter reads as a smooth line.
    for (let i = 1; i < p.length - 1; i++) {
      c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    }
    const last = p[p.length - 1];
    c.lineTo(last[0], last[1]);
  }
  c.stroke();
}

// Seeded randomness, so an arrow looks the same sloppy way every time it's drawn.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

const seedOf = (el) => el.seed ?? [...el.id].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261);

// A line drawn twice, each time a little off at the ends and bowed in the
// middle, the way rough.js draws Excalidraw's.
function sketchLine(c, rand, [ax, ay], [bx, by], width) {
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  const jitter = 1 + width * 0.35;
  const bow = Math.min(len * 0.04, 9) * rand() * 2;
  for (let pass = 0; pass < 2; pass++) {
    const j = jitter * (pass ? 1.4 : 0.6);
    const bend = bow + Math.min(len * 0.015, 3.5) * rand() * 2;
    const t = 0.5 + rand() * 0.2;
    c.moveTo(ax + rand() * j, ay + rand() * j);
    c.quadraticCurveTo(ax + (bx - ax) * t + nx * bend, ay + (by - ay) * t + ny * bend, bx + rand() * j, by + rand() * j);
  }
}

function drawArrow(c, el) {
  const rand = rng(seedOf(el));
  c.strokeStyle = el.color;
  c.lineWidth = el.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  for (const [a, b] of arrowSegments(el)) sketchLine(c, rand, a, b, el.width);
  c.stroke();
}

function drawText(c, el) {
  c.font = fontStr(el.size);
  c.fillStyle = el.color;
  c.textBaseline = 'alphabetic';
  const off = baselineOffset(el.size);
  el.text.split('\n').forEach((line, i) => {
    c.fillText(line, el.x, el.y + i * LINE_HEIGHT * el.size + off);
  });
}

function drawImage(c, el) {
  const file = files.get(el.fileId);
  if (!file || !file.img.complete || !file.img.naturalWidth) {
    // Still loading, or its file is gone
    c.fillStyle = '#e9ecef';
    c.fillRect(el.x, el.y, el.w, el.h);
    return;
  }
  c.save();
  if (document.documentElement.dataset.theme === 'dark') c.filter = IMAGE_INVERT_FILTER;
  c.imageSmoothingQuality = 'high';
  c.drawImage(file.img, el.x, el.y, el.w, el.h);
  c.restore();
}

function drawElement(c, el) {
  if (el.type === 'ink') drawInk(c, el);
  else if (el.type === 'arrow') drawArrow(c, el);
  else if (el.type === 'image') drawImage(c, el);
  else if (!editing || editing.id !== el.id) drawText(c, el);
}

function draw() {
  renderQueued = false;
  const { x, y, zoom } = state.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);
  const tl = toWorld(0, 0);
  const visible = { x: tl.x, y: tl.y, w: W / zoom, h: H / zoom };
  for (const el of state.elements) {
    if (intersects(bounds(el), visible)) drawElement(ctx, el);
  }
  if (pointer && pointer.stroke) drawInk(ctx, pointer.stroke);
  if (pointer && pointer.arrow) drawArrow(ctx, pointer.arrow);

  const sel = selection().filter((el) => !(editing && editing.id === el.id));
  if (sel.length) {
    const arrow = loneArrow(sel);
    ctx.strokeStyle = '#6965db';
    ctx.lineWidth = 1 / zoom;
    if (!arrow) {
      const b = selectionBox(sel);
      ctx.setLineDash([4 / zoom, 3 / zoom]);
      if (sel.length > 1) {
        ctx.globalAlpha = 0.45;
        for (const el of sel) {
          const eb = selectionBox([el]);
          ctx.strokeRect(eb.x, eb.y, eb.w, eb.h);
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
    }
    if (state.tool === 'select') {
      const hs = HANDLE_SIZE / zoom;
      ctx.fillStyle = '#ffffff';
      for (const [x, y] of Object.values(handles(sel))) {
        ctx.beginPath();
        if (arrow) ctx.arc(x, y, hs / 2 + 1 / zoom, 0, Math.PI * 2);
        else ctx.rect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  if (pointer && pointer.kind === 'lasso' && pointer.pts.length > 1) {
    ctx.beginPath();
    pointer.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(105, 101, 219, 0.08)';
    ctx.fill();
    ctx.strokeStyle = '#6965db';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.tool === 'eraser' && hover) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, ERASER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  $('#welcome').hidden = state.elements.length > 0 || !!(pointer && (pointer.stroke || pointer.arrow));
  $('.zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  const widthMatters = state.tool === 'draw' || state.tool === 'arrow' || selection().some(hasPts);
  $('.widths').classList.toggle('idle', !widthMatters);
  positionCandidates();
  if (editing) layoutEditor();
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  render();
}

/* ---------- history and storage ---------- */

const snapshot = () => JSON.stringify(state.elements);

function commit(snap) {
  undoStack.push(snap);
  if (undoStack.length > 300) undoStack.shift();
  redoStack = [];
  save();
}

function restore(snap) {
  state.elements = JSON.parse(snap);
  pendingIds = pendingIds.filter((id) => byId(id));
  if (pendingIds.length) scheduleConvert();
  else clearTimeout(convertTimer);
  hideCandidates();
  state.selectedIds = state.selectedIds.filter((id) => byId(id));
  save();
  render();
}

function undo() {
  if (editing) commitEdit();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

let saveTimer = null;
let storageWarned = false;
function writeStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      elements: state.elements,
      view: state.view,
      tool: state.tool,
      color: state.color,
      width: state.width,
      theme: document.documentElement.dataset.theme,
    }));
  } catch {
    if (!storageWarned) {
      storageWarned = true;
      toast('Could not save the board in this browser. Export it before closing.');
    }
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStorage, 300);
}

function load() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    data = null;
  }
  if (data && Array.isArray(data.elements)) {
    state.elements = data.elements;
    if (data.view) state.view = data.view;
    if (data.tool) state.tool = data.tool;
    if (data.color) state.color = data.color;
    if (data.width) state.width = data.width;
  }
  const dark = data && data.theme ? data.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function addFile(id, src) {
  if (!files.has(id)) {
    const img = new Image();
    img.onload = render;
    img.src = src;
    files.set(id, { src, img });
  }
  return files.get(id);
}

let filesDb = null;
function openFiles(mode) {
  if (!filesDb) {
    filesDb = new Promise((resolve, reject) => {
      const req = indexedDB.open(FILES_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return filesDb.then((db) => db.transaction('files', mode).objectStore('files'));
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function storeFile(id, src) {
  try {
    await done((await openFiles('readwrite')).put(src, id));
  } catch {
    toast('Could not save the picture in this browser. Export the board before closing.');
  }
}

// Loads the pictures the board uses and drops the ones nothing points at any more.
async function loadFiles() {
  try {
    const store = await openFiles('readwrite');
    const [ids, srcs] = await Promise.all([done(store.getAllKeys()), done(store.getAll())]);
    const used = new Set(state.elements.filter((el) => el.type === 'image').map((el) => el.fileId));
    ids.forEach((id, i) => (used.has(id) ? addFile(id, srcs[i]) : store.delete(id)));
  } catch {
    toast("Couldn't load the pictures on this board.");
  }
  render();
}

/* ---------- handwriting recognition ---------- */

function scheduleConvert() {
  clearTimeout(convertTimer);
  convertTimer = setTimeout(convertPending, CONVERT_DELAY);
}

// A stroke that starts well away from the current word or line begins a new one.
function farFromPending(w) {
  const strokes = pendingIds.map(byId).filter(Boolean);
  if (!strokes.length) return false;
  const b = unionBounds(strokes, false);
  // Lowercase-only words are short, so leave room for ascenders and descenders.
  const h = Math.max(b.h, 40 / state.view.zoom);
  return w.x < b.x - h * 1.5 || w.x > b.x + b.w + h * 2.5 || w.y < b.y - h || w.y > b.y + b.h + h;
}

async function recognize(strokes) {
  const b = unionBounds(strokes, false);
  // Normalise so the line is ~150 units tall whatever the zoom was.
  const k = 150 / Math.max(b.h, b.w / 20, 1);
  const t0 = Math.min(...strokes.map((s) => s.t0));
  const ink = strokes.map((s) => [
    s.pts.map((p) => Math.round((p[0] - b.x) * k)),
    s.pts.map((p) => Math.round((p[1] - b.y) * k)),
    s.pts.map((p) => s.t0 - t0 + p[2]),
  ]);
  const res = await fetch(RECOGNIZER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      options: 'enable_pre_space',
      requests: [{
        writing_guide: {
          writing_area_width: Math.max(1, Math.round(b.w * k)),
          writing_area_height: Math.max(1, Math.round(b.h * k)),
        },
        ink,
        language: LANG,
      }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (data[0] !== 'SUCCESS') throw new Error(String(data[0]));
  const list = ((data[1] && data[1][0] && data[1][0][1]) || []).map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

// Google's recognizer has no math mode and reads Σ as "E" or "2", so Σ is
// spotted here by comparing the ink to a template, and the rest of the line is
// read in pieces around it.
const SIGMA = '\u2211';
const SIGMA_THRESHOLD = 0.095;
const SIGMA_MAX_STROKES = 3;

function resample(pts, n) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = lens[lens.length - 1];
  const out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    if (!total) {
      out.push([pts[0][0], pts[0][1]]);
      continue;
    }
    const d = (total * k) / (n - 1);
    while (j < pts.length - 1 && lens[j] < d) j++;
    const t = clamp((d - lens[j - 1]) / (lens[j] - lens[j - 1] || 1), 0, 1);
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t]);
  }
  return out;
}

// Top bar leftwards, in to the middle, out to the bottom left, bottom bar
// rightwards; or the top bar drawn rightwards and gone back over. Each one
// also backwards.
const SIGMA_TEMPLATES = [
  [[1, 0], [0, 0], [0.55, 0.5], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [0, 0], [0.55, 0.5], [0, 1], [1, 1]],
].flatMap((t) => {
  const r = resample(t, 32);
  return [r, [...r].reverse()];
});

// Mean distance from a path (in drawing order) to the closest Σ template.
function sigmaScore(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const w = x1 - x0;
  const h = y1 - y0;
  if (pts.length < 5 || w < 1 || h < 1 || w / h < 0.4 || w / h > 2.2) return Infinity;
  const p = resample(pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h]), 32);
  return Math.min(...SIGMA_TEMPLATES.map((t) => p.reduce((s, q, i) => s + Math.hypot(q[0] - t[i][0], q[1] - t[i][1]), 0) / p.length));
}

const permutations = (list) => (list.length <= 1
  ? [list]
  : list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [x, ...rest])));

// Σ drawn in one go or in a few strokes (say, the top bar on its own): tries the
// strokes in every order and direction, and takes them as a Σ when they join up
// end to end into one.
function isSigma(group) {
  const b = unionBounds(group, false);
  const gap = Math.max(b.w, b.h) * 0.3;
  for (const order of permutations(group)) {
    for (let flips = 0; flips < 1 << order.length; flips++) {
      const parts = order.map((s, i) => ((flips >> i) & 1 ? [...s.pts].reverse() : s.pts));
      const joined = parts.every((part, i) => {
        if (i === 0) return true;
        const a = parts[i - 1][parts[i - 1].length - 1];
        return Math.hypot(part[0][0] - a[0], part[0][1] - a[1]) <= gap;
      });
      if (joined && sigmaScore(parts.flat()) < SIGMA_THRESHOLD) return true;
    }
  }
  return false;
}

// Runs of consecutive strokes that make a Σ, trying single strokes first.
function findSigmas(strokes) {
  const used = new Set();
  const found = [];
  for (let n = 1; n <= SIGMA_MAX_STROKES; n++) {
    for (let i = 0; i + n <= strokes.length; i++) {
      const group = strokes.slice(i, i + n);
      if (group.some((s) => used.has(s)) || !isSigma(group)) continue;
      group.forEach((s) => used.add(s));
      found.push(group);
    }
  }
  return found;
}

// A Σ that isn't spotted mostly reads as "E": offer the same reading with ∑ in
// place of the E, right after the best guess.
function withSigmaOption(cands) {
  const withE = cands.find((c) => c.includes('E'));
  if (!withE) return cands;
  const option = withE.replaceAll('E', SIGMA);
  if (cands.includes(option)) return cands;
  return [cands[0], option, ...cands.slice(1)];
}

async function readStrokes(strokes) {
  const sigmas = findSigmas(strokes);
  if (!sigmas.length) return recognize(strokes);

  // Split the line at each Σ and read the pieces between them on their own.
  const inSigma = new Set(sigmas.flat());
  const centerX = (list) => {
    const b = unionBounds(list, false);
    return b.x + b.w / 2;
  };
  const marks = sigmas.map(centerX).sort((a, b) => a - b);
  const groups = marks.map(() => []).concat([[]]);
  for (const s of strokes) {
    if (inSigma.has(s)) continue;
    const x = centerX([s]);
    let g = 0;
    while (g < marks.length && x > marks[g]) g++;
    groups[g].push(s);
  }
  const [parts, whole] = await Promise.all([
    Promise.all(groups.map((g) => (g.length ? recognize(g) : Promise.resolve([''])))),
    recognize(strokes).catch(() => []),
  ]);

  const join = (texts) => texts.reduce((out, t, i) => (i === 0 ? t : `${out}${out ? ' ' : ''}${SIGMA}${t}`), '');
  const best = parts.map((p) => p[0] || '');
  const cands = [join(best)];
  const last = best.map((t) => !!t).lastIndexOf(true);
  if (last >= 0) {
    for (const alt of parts[last].slice(1, 5)) {
      const texts = [...best];
      texts[last] = alt;
      cands.push(join(texts));
    }
  }
  // Plain readings last, in case it was an E or a 2 after all.
  return [...new Set([...cands, ...whole])];
}

// Font size whose letters cover the same height (or width) as the handwriting.
function fitText(text, b) {
  measureCtx.font = fontStr(100);
  const m = measureCtx.measureText(text);
  const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const byHeight = inkH > 5 ? (b.h / inkH) * 100 : Infinity;
  const byWidth = m.width > 5 ? (b.w / m.width) * 100 * 1.4 : Infinity;
  let size = Math.min(byHeight, byWidth);
  if (!Number.isFinite(size)) size = 28 / state.view.zoom;
  size = clamp(Math.round(size * 10) / 10, 6, 1000);
  const scale = size / 100;
  const x = b.x + m.actualBoundingBoxLeft * scale;
  const y = b.y + m.actualBoundingBoxAscent * scale - baselineOffset(size);
  return { size, x, y };
}

async function convertPending() {
  clearTimeout(convertTimer);
  const ids = pendingIds;
  pendingIds = [];
  if (!ids.some((id) => byId(id))) return;

  inflight++;
  $('#status').hidden = false;
  let cands = [];
  try {
    cands = withSigmaOption(await readStrokes(ids.map(byId).filter(Boolean)));
  } catch {
    toast("Couldn't reach the handwriting recognizer, so your ink was kept. Are you offline?");
  } finally {
    inflight--;
    $('#status').hidden = inflight === 0;
  }

  // The strokes may have been erased, moved or undone while we waited.
  const strokes = ids.map(byId);
  if (!cands.length || strokes.some((s) => !s)) return;

  const snap = snapshot();
  const fit = fitText(cands[0], unionBounds(strokes, false));
  const firstIndex = state.elements.indexOf(strokes[0]);
  const text = { id: uid(), type: 'text', text: cands[0], color: strokes[0].color, ...fit };
  state.elements = state.elements.filter((el) => !ids.includes(el.id));
  state.elements.splice(Math.min(firstIndex, state.elements.length), 0, text);
  commit(snap);
  showCandidates(text.id, JSON.parse(JSON.stringify(strokes)), cands);
  render();
}

function showCandidates(textId, strokes, cands) {
  candidateFor = { textId, strokes, cands };
  candidatesBox.replaceChildren();
  cands.slice(0, 6).forEach((c, i) => {
    const b = document.createElement('button');
    b.textContent = c;
    b.title = 'Use this';
    if (i === 0) b.classList.add('active');
    b.addEventListener('click', () => chooseCandidate(c, b));
    candidatesBox.append(b);
  });
  const keep = document.createElement('button');
  keep.className = 'keep';
  keep.title = 'Keep my handwriting (Esc)';
  keep.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/></svg>Keep ink';
  keep.addEventListener('click', keepInk);
  candidatesBox.append(keep);
  candidatesBox.hidden = false;
  positionCandidates();
}

function positionCandidates() {
  if (!candidateFor) return;
  const el = byId(candidateFor.textId);
  if (!el) return hideCandidates();
  const b = textBounds(el);
  const below = toScreen(b.x, b.y + b.h);
  const above = toScreen(b.x, b.y);
  const bw = candidatesBox.offsetWidth;
  const bh = candidatesBox.offsetHeight;
  let top = below.y + 8;
  if (top + bh > H - 8) top = above.y - bh - 8;
  candidatesBox.style.left = `${clamp(below.x, 8, Math.max(8, W - bw - 8))}px`;
  candidatesBox.style.top = `${clamp(top, 8, Math.max(8, H - bh - 8))}px`;
}

function hideCandidates() {
  candidateFor = null;
  candidatesBox.hidden = true;
}

function chooseCandidate(c, button) {
  const el = byId(candidateFor.textId);
  if (!el) return hideCandidates();
  const snap = snapshot();
  Object.assign(el, { text: c }, fitText(c, unionBounds(candidateFor.strokes, false)));
  commit(snap);
  for (const b of candidatesBox.children) b.classList.toggle('active', b === button);
  render();
}

function keepInk() {
  if (!candidateFor) return;
  const { textId, strokes } = candidateFor;
  const index = state.elements.findIndex((el) => el.id === textId);
  hideCandidates();
  if (index < 0) return;
  const snap = snapshot();
  state.elements.splice(index, 1, ...strokes);
  commit(snap);
  render();
}

/* ---------- text editing ---------- */

function startEdit(el, snap = snapshot()) {
  hideCandidates();
  state.selectedIds = [el.id];
  editing = { id: el.id, snap };
  editor.value = el.text;
  editor.hidden = false;
  layoutEditor();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  render();
}

function layoutEditor() {
  const el = byId(editing.id);
  if (!el) return;
  const z = state.view.zoom;
  const b = textBounds(el);
  const p = toScreen(el.x, el.y);
  editor.style.left = `${p.x}px`;
  editor.style.top = `${p.y}px`;
  editor.style.fontSize = `${el.size * z}px`;
  editor.style.color = el.color;
  editor.style.width = `${(b.w + el.size) * z}px`;
  editor.style.height = `${b.h * z}px`;
}

function commitEdit() {
  if (!editing) return;
  const { id, snap } = editing;
  editing = null;
  editor.hidden = true;
  editor.blur();
  if (state.tool !== 'select') state.selectedIds = [];
  const el = byId(id);
  if (el) {
    el.text = editor.value.replace(/\s+$/, '');
    if (!el.text.trim()) {
      state.elements = state.elements.filter((e) => e.id !== id);
      state.selectedIds = state.selectedIds.filter((s) => s !== id);
    }
  }
  if (snapshot() !== snap) commit(snap);
  render();
}

editor.addEventListener('input', () => {
  const el = editing && byId(editing.id);
  if (el) el.text = editor.value;
  layoutEditor();
});
editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    commitEdit();
  }
});
editor.addEventListener('blur', commitEdit);

/* ---------- pointer input ---------- */

// With Shift held, an arrow keeps to steps of 15 degrees.
function arrowEnd(from, w, shift) {
  if (!shift) return [round2(w.x), round2(w.y)];
  const step = Math.PI / 12;
  const a = Math.round(Math.atan2(w.y - from[1], w.x - from[0]) / step) * step;
  const len = Math.hypot(w.x - from[0], w.y - from[1]);
  return [round2(from[0] + Math.cos(a) * len), round2(from[1] + Math.sin(a) * len)];
}

function eraseAt(sx, sy) {
  const w = toWorld(sx, sy);
  const r = ERASER_RADIUS / state.view.zoom;
  const keep = state.elements.filter((el) => !hits(el, w.x, w.y, r));
  if (keep.length !== state.elements.length) {
    state.elements = keep;
    pointer.erased = true;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (editing) commitEdit();
  if (pointer) return;
  hideCandidates();
  const w = toWorld(e.clientX, e.clientY);

  if (e.button === 1 || (e.button === 0 && (spaceDown || state.tool === 'hand'))) {
    canvas.setPointerCapture(e.pointerId);
    pointer = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
    setCursor();
    return;
  }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);

  switch (state.tool) {
    case 'write':
      clearTimeout(convertTimer);
      if (pendingIds.length && farFromPending(w)) convertPending();
    // falls through
    case 'draw':
      pointer = {
        kind: 'ink',
        write: state.tool === 'write',
        stroke: {
          id: uid(),
          type: 'ink',
          color: state.color,
          width: state.tool === 'write' ? WRITE_WIDTH : state.width,
          t0: Date.now(),
          pts: [[round2(w.x), round2(w.y), 0]],
        },
      };
      break;
    case 'arrow':
      pointer = {
        kind: 'arrow',
        arrow: {
          id: uid(),
          type: 'arrow',
          color: state.color,
          width: state.width,
          seed: Math.floor(Math.random() * 2 ** 31),
          pts: [[round2(w.x), round2(w.y)], [round2(w.x), round2(w.y)]],
        },
      };
      break;
    case 'eraser':
      pointer = { kind: 'erase', snap: snapshot(), erased: false };
      eraseAt(e.clientX, e.clientY);
      break;
    case 'select': {
      const corner = handleAt(e.clientX, e.clientY);
      const sel = selection();
      if (corner === 'start' || corner === 'end') {
        pointer = { kind: 'arrow-end', id: sel[0].id, end: corner === 'start' ? 0 : 1, snap: snapshot(), moved: false };
        break;
      }
      if (corner && sel.length) {
        pointer = {
          kind: 'resize',
          corner,
          origs: JSON.parse(JSON.stringify(sel)),
          box: unionBounds(sel, false),
          snap: snapshot(),
          moved: false,
        };
        break;
      }
      const hit = hitTest(w.x, w.y);
      if (hit && e.shiftKey) {
        // Shift+click adds to the selection or takes out of it
        state.selectedIds = isSelected(hit.id)
          ? state.selectedIds.filter((id) => id !== hit.id)
          : [...state.selectedIds, hit.id];
      } else if (hit) {
        if (!isSelected(hit.id)) state.selectedIds = [hit.id];
        pointer = { kind: 'move', last: w, snap: snapshot(), moved: false };
      } else {
        // Dragging on empty board draws a loop; what's inside gets selected
        if (!e.shiftKey) state.selectedIds = [];
        pointer = { kind: 'lasso', pts: [[w.x, w.y]], add: e.shiftKey };
      }
      break;
    }
  }
  render();
});

canvas.addEventListener('pointermove', (e) => {
  hover = { x: e.clientX, y: e.clientY };
  if (!pointer) {
    if (state.tool === 'eraser') render();
    if (state.tool === 'select' && !spaceDown) {
      const corner = handleAt(e.clientX, e.clientY);
      canvas.style.cursor = corner ? RESIZE_CURSORS[corner] : 'default';
    }
    return;
  }
  switch (pointer.kind) {
    case 'pan':
      state.view.x = pointer.vx + e.clientX - pointer.sx;
      state.view.y = pointer.vy + e.clientY - pointer.sy;
      break;
    case 'ink': {
      const s = pointer.stroke;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events.length ? events : [e]) {
        const w = toWorld(ev.clientX, ev.clientY);
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(w.x - last[0], w.y - last[1]) * state.view.zoom < 1) continue;
        s.pts.push([round2(w.x), round2(w.y), Date.now() - s.t0]);
      }
      break;
    }
    case 'arrow': {
      const { pts } = pointer.arrow;
      pts[1] = arrowEnd(pts[0], toWorld(e.clientX, e.clientY), e.shiftKey);
      break;
    }
    case 'arrow-end': {
      const el = byId(pointer.id);
      if (!el) break;
      el.pts[pointer.end] = arrowEnd(el.pts[1 - pointer.end], toWorld(e.clientX, e.clientY), e.shiftKey);
      pointer.moved = true;
      break;
    }
    case 'erase':
      eraseAt(e.clientX, e.clientY);
      break;
    case 'move': {
      const w = toWorld(e.clientX, e.clientY);
      for (const el of selection()) moveElement(el, w.x - pointer.last.x, w.y - pointer.last.y);
      pointer.last = w;
      pointer.moved = true;
      break;
    }
    case 'resize':
      resizeSelection(pointer, toWorld(e.clientX, e.clientY));
      pointer.moved = true;
      break;
    case 'lasso': {
      const w = toWorld(e.clientX, e.clientY);
      const last = pointer.pts[pointer.pts.length - 1];
      if (Math.hypot(w.x - last[0], w.y - last[1]) * state.view.zoom >= 2) pointer.pts.push([w.x, w.y]);
      break;
    }
  }
  render();
});

function endPointer() {
  if (!pointer) return;
  const p = pointer;
  pointer = null;
  if (p.kind === 'ink') {
    const snap = snapshot();
    state.elements.push(p.stroke);
    commit(snap);
    if (p.write) {
      pendingIds.push(p.stroke.id);
      scheduleConvert();
      const b = inkBounds(p.stroke, false);
      if (Math.max(b.w, b.h) * state.view.zoom < 4) taps.push({ id: p.stroke.id, snap, at: Date.now() });
    }
  } else if (p.kind === 'arrow') {
    // A click without a drag leaves no arrow
    const [[x0, y0], [x1, y1]] = p.arrow.pts;
    if (Math.hypot(x1 - x0, y1 - y0) * state.view.zoom >= 4) {
      const snap = snapshot();
      state.elements.push(p.arrow);
      commit(snap);
    }
  } else if (p.kind === 'erase') {
    pendingIds = pendingIds.filter((id) => byId(id));
    if (p.erased) commit(p.snap);
  } else if (p.kind === 'move' || p.kind === 'resize' || p.kind === 'arrow-end') {
    if (p.moved) commit(p.snap);
  } else if (p.kind === 'lasso') {
    const picked = lassoPick(p.pts);
    state.selectedIds = p.add ? [...new Set([...state.selectedIds, ...picked])] : picked;
  } else {
    save();
  }
  setCursor();
  render();
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  hover = null;
  render();
});

// A double-click in Write mode leaves two dots before the browser calls it a
// double-click; they go again, undo history and all.
function dropTaps() {
  const recent = taps.filter((t) => Date.now() - t.at < 1000 && byId(t.id));
  taps = [];
  if (!recent.length) return;
  const ids = recent.map((t) => t.id);
  for (const t of [...recent].reverse()) {
    if (undoStack[undoStack.length - 1] === t.snap) undoStack.pop();
  }
  state.elements = state.elements.filter((el) => !ids.includes(el.id));
  pendingIds = pendingIds.filter((id) => !ids.includes(id));
  if (pendingIds.length) convertPending();
  else clearTimeout(convertTimer);
  save();
}

// Double-click edits a text, or starts a new one on empty board, in Select and Write mode alike.
canvas.addEventListener('dblclick', (e) => {
  if (state.tool === 'write') dropTaps();
  else if (state.tool !== 'select') return;
  const w = toWorld(e.clientX, e.clientY);
  const hit = hitTest(w.x, w.y);
  if (hit && hit.type === 'text') {
    startEdit(hit);
  } else if (!hit) {
    const snap = snapshot();
    const size = 28 / state.view.zoom;
    const el = { id: uid(), type: 'text', text: '', color: state.color, size, x: w.x, y: w.y - (LINE_HEIGHT * size) / 2 };
    state.elements.push(el);
    startEdit(el, snap);
  }
});

function zoomAt(sx, sy, factor) {
  const z = clamp(state.view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const w = toWorld(sx, sy);
  state.view.zoom = z;
  state.view.x = sx - w.x * z;
  state.view.y = sy - w.y * z;
  save();
  render();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : 1;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(e.clientX, e.clientY, Math.exp(-clamp(dy, -100, 100) * 0.004));
    return;
  }
  if (e.shiftKey && !dx) {
    dx = dy;
    dy = 0;
  }
  state.view.x -= dx;
  state.view.y -= dy;
  save();
  render();
}, { passive: false });

/* ---------- tools, keys and buttons ---------- */

function setCursor() {
  let c = 'crosshair';
  if (pointer && pointer.kind === 'pan') c = 'grabbing';
  else if (spaceDown || state.tool === 'hand') c = 'grab';
  else if (state.tool === 'select') c = 'default';
  else if (state.tool === 'eraser') c = 'none';
  canvas.style.cursor = c;
}

function setTool(tool) {
  if (state.tool === 'write' && tool !== 'write' && pendingIds.length) convertPending();
  state.tool = tool;
  if (tool !== 'select') state.selectedIds = [];
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  setCursor();
  save();
  render();
}

function setColor(color) {
  state.color = color;
  document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
  const recolor = selection().filter((el) => el.color !== color);
  if (recolor.length) {
    const snap = snapshot();
    for (const el of recolor) el.color = color;
    commit(snap);
  }
  save();
  render();
}

// Sets the width for Draw and arrows, and of the selected ink and arrows.
function setWidth(width) {
  state.width = width;
  document.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === width));
  const rewidth = selection().filter((el) => hasPts(el) && el.width !== width);
  if (rewidth.length) {
    const snap = snapshot();
    for (const el of rewidth) el.width = width;
    commit(snap);
  }
  save();
  render();
}

function deleteSelected() {
  if (!selection().length) return;
  const snap = snapshot();
  state.elements = state.elements.filter((el) => !isSelected(el.id));
  pendingIds = pendingIds.filter((id) => byId(id));
  state.selectedIds = [];
  commit(snap);
  render();
}

function clearBoard() {
  if (!state.elements.length || !confirm('Clear the whole board? You can undo this.')) return;
  const snap = snapshot();
  state.elements = [];
  pendingIds = [];
  state.selectedIds = [];
  hideCandidates();
  commit(snap);
  render();
}

function toggleTheme() {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  save();
  render();
}

function exportPng() {
  if (!state.elements.length) return toast('Nothing to export yet.');
  const b = unionBounds(state.elements);
  const pad = 32;
  const scale = Math.min(2, 16000 / (b.w + 2 * pad), 16000 / (b.h + 2 * pad));
  const out = document.createElement('canvas');
  out.width = Math.ceil((b.w + 2 * pad) * scale);
  out.height = Math.ceil((b.h + 2 * pad) * scale);
  const c = out.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, out.width, out.height);
  c.setTransform(scale, 0, 0, scale, (pad - b.x) * scale, (pad - b.y) * scale);
  for (const el of state.elements) drawElement(c, el);

  let final = out;
  if (document.documentElement.dataset.theme === 'dark') {
    final = document.createElement('canvas');
    final.width = out.width;
    final.height = out.height;
    const fc = final.getContext('2d');
    fc.filter = 'invert(93%) hue-rotate(180deg)';
    fc.drawImage(out, 0, 0);
  }
  final.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inkboard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const actions = {
  export: exportPng,
  theme: toggleTheme,
  clear: clearBoard,
  undo,
  redo,
  'zoom-in': () => zoomAt(W / 2, H / 2, 1.2),
  'zoom-out': () => zoomAt(W / 2, H / 2, 1 / 1.2),
  'zoom-reset': () => zoomAt(W / 2, H / 2, 1 / state.view.zoom),
};

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
document.querySelectorAll('[data-width]').forEach((b) => b.addEventListener('click', () => setWidth(Number(b.dataset.width))));
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.action]()));
// Keep keyboard focus on the board so shortcuts keep working after a click.
document.querySelectorAll('.island').forEach((el) => el.addEventListener('mousedown', (e) => e.preventDefault()));

const toolKeys = {
  h: 'hand', v: 'select', 1: 'select', w: 'write', 2: 'write', p: 'draw', 3: 'draw', e: 'eraser', 4: 'eraser', a: 'arrow', 5: 'arrow',
};

window.addEventListener('keydown', (e) => {
  if (editing) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      setCursor();
    }
    return;
  }
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key === 'y') return e.preventDefault(), redo();
  if (mod && (key === '=' || key === '+')) return e.preventDefault(), actions['zoom-in']();
  if (mod && key === '-') return e.preventDefault(), actions['zoom-out']();
  if (mod && key === '0') return e.preventDefault(), actions['zoom-reset']();
  if (mod && e.shiftKey && key === 'e') return e.preventDefault(), exportPng();
  if (e.shiftKey && e.altKey && e.code === 'KeyD') return e.preventDefault(), toggleTheme();
  if (mod && key === 'a') {
    e.preventDefault();
    setTool('select');
    state.selectedIds = state.elements.map((el) => el.id);
    return render();
  }
  if (mod || e.altKey) return;

  if (toolKeys[key]) return setTool(toolKeys[key]);
  if (e.key === 'Enter') {
    const sel = selection();
    if (pendingIds.length) convertPending();
    else if (sel.length === 1 && sel[0].type === 'text') {
      e.preventDefault();
      startEdit(sel[0]);
    }
  } else if (e.key === 'Escape') {
    if (candidateFor) keepInk();
    else if (pendingIds.length) {
      clearTimeout(convertTimer);
      pendingIds = [];
    } else {
      state.selectedIds = [];
      render();
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    setCursor();
  }
});

/* ---------- copy and paste ---------- */

// Ctrl+C puts the selection on the clipboard twice: whole, for pasting back on
// a board, and as the words of its texts (top to bottom, then left to right)
// for pasting elsewhere.
function copySelection(e) {
  const sel = state.elements.filter((el) => isSelected(el.id));
  if (editing || !sel.length) return false;
  e.preventDefault();
  const texts = sel.filter((el) => el.type === 'text').sort((a, b) => a.y - b.y || a.x - b.x);
  if (texts.length) e.clipboardData.setData('text/plain', texts.map((el) => el.text).join('\n'));
  const srcs = {};
  for (const el of sel) {
    if (el.type === 'image' && files.has(el.fileId)) srcs[el.fileId] = files.get(el.fileId).src;
  }
  e.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify({ elements: sel, files: srcs }));
  return true;
}

document.addEventListener('copy', (e) => {
  const n = selection().length;
  if (copySelection(e)) toast(n > 1 ? `Copied ${n} items.` : 'Copied.');
});

document.addEventListener('cut', (e) => {
  if (copySelection(e)) deleteSelected();
});

// Puts pasted elements on the board centred on the mouse (or the middle of the
// screen) and selects them, ready to move or resize.
function addPasted(list) {
  const snap = snapshot();
  const b = unionBounds(list, false);
  const at = hover ? toWorld(hover.x, hover.y) : toWorld(W / 2, H / 2);
  for (const el of list) moveElement(el, at.x - (b.x + b.w / 2), at.y - (b.y + b.h / 2));
  hideCandidates();
  state.elements.push(...list);
  commit(snap);
  setTool('select');
  state.selectedIds = list.map((el) => el.id);
  render();
}

function pasteText(text) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/^\s*\n/, '').replace(/\s+$/, '');
  if (!clean) return;
  addPasted([{ id: uid(), type: 'text', text: clean, color: state.color, size: 28 / state.view.zoom, x: 0, y: 0 }]);
}

// A picture goes on the board byte for byte, at its real pixel size unless
// that wouldn't fit on screen.
async function pasteImage(blob) {
  const src = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
  const fileId = uid();
  const { img } = addFile(fileId, src || '');
  try {
    await img.decode();
  } catch {
    files.delete(fileId);
    return toast("That picture couldn't be opened.");
  }
  storeFile(fileId, src);
  const w = img.naturalWidth / dpr;
  const h = img.naturalHeight / dpr;
  const s = Math.min(1, (W * 0.8) / w, (H * 0.8) / h) / state.view.zoom;
  addPasted([{ id: uid(), type: 'image', fileId, x: 0, y: 0, w: w * s, h: h * s }]);
}

function pasteElements(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.elements) || !data.elements.length) return;
  for (const [id, src] of Object.entries(data.files || {})) {
    if (!files.has(id)) storeFile(id, src);
    addFile(id, src);
  }
  addPasted(data.elements.map((el) => ({ ...el, id: uid() })));
}

document.addEventListener('paste', (e) => {
  if (editing) return;
  const data = e.clipboardData;
  const own = data.getData(CLIPBOARD_TYPE);
  const text = data.getData('text/plain');
  const image = [...data.files].find((f) => f.type.startsWith('image/'));
  // Office apps put a picture of the copied text next to the text itself; the text is what's wanted then.
  const textWithPicture = text.trim() && !/<img\b/i.test(data.getData('text/html'));
  e.preventDefault();
  if (own) pasteElements(own);
  else if (image && !textWithPicture) pasteImage(image);
  else pasteText(text);
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  writeStorage();
});

load();
setTool(state.tool);
setColor(state.color);
setWidth(state.width);
resize();
loadFiles();
document.fonts.load(fontStr(20), 'Aa').then(() => {
  fontRatios = null;
  render();
});

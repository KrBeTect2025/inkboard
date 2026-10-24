'use strict';

// Recognition language, as a Google Input Tools code ('en', 'hi', 'de', 'fr', ...).
const LANG = 'en';
// How long the pen has to rest before handwriting turns into text.
const CONVERT_DELAY = 900;
const RECOGNIZER = 'https://inputtools.google.com/request?ime=handwriting&app=inkboard&cs=1&oe=UTF-8';

const FONT = 'Excalifont';
const LINE_HEIGHT = 1.25;
const INK_WIDTH = { write: 2.5, draw: 3 };
const ERASER_RADIUS = 10;
const HANDLE_SIZE = 8;
const RESIZE_CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const STORAGE_KEY = 'inkboard:v1';

const $ = (s) => document.querySelector(s);
const canvas = $('#board');
const ctx = canvas.getContext('2d');
const measureCtx = document.createElement('canvas').getContext('2d');
const editor = $('#editor');
const candidatesBox = $('#candidates');

const state = {
  tool: 'write',
  color: '#1e1e1e',
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
let fontRatios = null;

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

const bounds = (el, padded = true) => (el.type === 'text' ? textBounds(el) : inkBounds(el, padded));

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
  if (el.type === 'text') {
    const b = textBounds(el);
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

// Which resize handle of the selection is under the pointer, if any.
function handleAt(sx, sy) {
  const sel = selection();
  if (!sel.length || state.tool !== 'select' || editing) return null;
  for (const [name, [x, y]] of Object.entries(corners(selectionBox(sel)))) {
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
    if (el.type === 'text') {
      el.size = orig.size * s;
      el.x = ax + (orig.x - ax) * s;
      el.y = ay + (orig.y - ay) * s;
    } else {
      el.pts = orig.pts.map(([x, y, t]) => [round2(ax + (x - ax) * s), round2(ay + (y - ay) * s), t]);
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
    if (el.type === 'text') {
      const b = textBounds(el);
      samples = [0, 0.5, 1].flatMap((fx) => [0, 0.5, 1].map((fy) => [b.x + b.w * fx, b.y + b.h * fy]));
    } else {
      samples = el.pts;
    }
    const inside = samples.filter(([x, y]) => insidePolygon(x, y, poly)).length;
    return inside >= samples.length * 0.6;
  }).map((el) => el.id);
}

function moveElement(el, dx, dy) {
  if (el.type === 'text') {
    el.x += dx;
    el.y += dy;
  } else {
    for (const p of el.pts) {
      p[0] = round2(p[0] + dx);
      p[1] = round2(p[1] + dy);
    }
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

function drawText(c, el) {
  c.font = fontStr(el.size);
  c.fillStyle = el.color;
  c.textBaseline = 'alphabetic';
  const off = baselineOffset(el.size);
  el.text.split('\n').forEach((line, i) => {
    c.fillText(line, el.x, el.y + i * LINE_HEIGHT * el.size + off);
  });
}

function drawElement(c, el) {
  if (el.type === 'ink') drawInk(c, el);
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

  const sel = selection().filter((el) => !(editing && editing.id === el.id));
  if (sel.length) {
    const b = selectionBox(sel);
    ctx.strokeStyle = '#6965db';
    ctx.lineWidth = 1 / zoom;
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
    if (state.tool === 'select') {
      const hs = HANDLE_SIZE / zoom;
      ctx.fillStyle = '#ffffff';
      for (const [x, y] of Object.values(corners(b))) {
        ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
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

  $('#welcome').hidden = state.elements.length > 0 || !!(pointer && pointer.stroke);
  $('.zoom-label').textContent = `${Math.round(zoom * 100)}%`;
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
  }
  const dark = data && data.theme ? data.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
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
          width: INK_WIDTH[state.tool],
          t0: Date.now(),
          pts: [[round2(w.x), round2(w.y), 0]],
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
    }
  } else if (p.kind === 'erase') {
    pendingIds = pendingIds.filter((id) => byId(id));
    if (p.erased) commit(p.snap);
  } else if (p.kind === 'move' || p.kind === 'resize') {
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

canvas.addEventListener('dblclick', (e) => {
  if (state.tool !== 'select') return;
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
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.action]()));
// Keep keyboard focus on the board so shortcuts keep working after a click.
document.querySelectorAll('.island').forEach((el) => el.addEventListener('mousedown', (e) => e.preventDefault()));

const toolKeys = { h: 'hand', v: 'select', 1: 'select', w: 'write', 2: 'write', p: 'draw', 3: 'draw', e: 'eraser', 4: 'eraser' };

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

// Ctrl+C copies the words of the selected texts (top to bottom, then left to
// right), so recognized text can be pasted elsewhere.
document.addEventListener('copy', (e) => {
  const texts = selection().filter((el) => el.type === 'text').sort((a, b) => a.y - b.y || a.x - b.x);
  if (editing || !texts.length) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', texts.map((el) => el.text).join('\n'));
  toast(texts.length > 1 ? `Copied ${texts.length} texts.` : 'Copied the text.');
});

window.addEventListener('resize', resize);
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  writeStorage();
});

load();
setTool(state.tool);
setColor(state.color);
resize();
document.fonts.load(fontStr(20), 'Aa').then(() => {
  fontRatios = null;
  render();
});

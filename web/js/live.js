// =====================================================
// LIVE — opt-in sync between the page and one layout file on disk.
//
// Active only when the URL has ?live AND the page is served by
// `python scripts/serve.py --watch <layout.json>`. Otherwise it does nothing,
// so the hosted app and plain static serving are unaffected.
//
//   file changes on disk (editor, script, coding agent) -> page reloads it
//   page model changes (place, erase, undo, ...)        -> file is rewritten
//
// Loading goes through the same path as the Load button (applyLoadedData +
// the iconic:* events), so a live load behaves like a manual one.
// =====================================================
import { applyLoadedData } from './load.js';
import { markModelChanged } from './app.js';
import { serialize } from './io.js';

const BASE = '__live';
const SAVE_DEBOUNCE_MS = 400;

let lastText = null;   // the layout text both sides currently agree on
let applying = false;  // true while a file load is being applied
let saveTimer = null;
let badge = null;
let filePath = '';

function setStatus(text, kind = 'ok') {
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'live-status';
    badge.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:9999',
      'font:12px/1.4 "JetBrains Mono",monospace', 'padding:6px 10px',
      'border-radius:4px', 'border:1px solid', 'max-width:420px',
      'pointer-events:none', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(badge);
  }
  const colors = {
    ok: ['#0e2a1a', '#3fbf6f', '#bff0cf'],
    busy: ['#1d2236', '#5b7bd5', '#cfdaff'],
    error: ['#3a1414', '#e05555', '#ffd2d2'],
  }[kind];
  badge.style.background = colors[0];
  badge.style.borderColor = colors[1];
  badge.style.color = colors[2];
  badge.textContent = `LIVE ${filePath}\n${text}`;
  badge.dataset.kind = kind;
}

function clock() {
  return new Date().toLocaleTimeString();
}

function currentText() {
  return JSON.stringify(serialize(false), null, 2) + '\n';
}

async function loadFromFile({ initial = false } = {}) {
  const resp = await fetch(`${BASE}/layout`, { cache: 'no-store' });
  if (resp.status === 404) {
    setStatus('no file yet: it is created on your first edit');
    return;
  }
  const text = await resp.text();
  if (text === lastText) return; // our own save, or no real change
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    setStatus(`file is not valid JSON, kept the current design\n${err.message}`, 'error');
    return;
  }
  applying = true;
  try {
    applyLoadedData(data);
    markModelChanged();
    window.dispatchEvent(new Event('iconic:project'));
    window.dispatchEvent(new Event('iconic:loaded'));
    lastText = text;
    const n = Array.isArray(data.entities) ? data.entities.length : 0;
    setStatus(`${initial ? 'loaded' : 'reloaded from disk'} ${clock()}: ${n} entities`);
  } catch (err) {
    setStatus(`could not load the file\n${err.message}`, 'error');
  } finally {
    applying = false;
  }
}

async function saveToFile() {
  saveTimer = null;
  const text = currentText();
  if (text === lastText) return;
  setStatus('saving…', 'busy');
  try {
    const resp = await fetch(`${BASE}/layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    if (!resp.ok) throw new Error((await resp.text()) || resp.statusText);
    lastText = text;
    setStatus(`saved to disk ${clock()}`);
  } catch (err) {
    setStatus(`save failed\n${err.message}`, 'error');
  }
}

export async function initLive() {
  if (!new URLSearchParams(location.search).has('live')) return;
  let info;
  try {
    const resp = await fetch(`${BASE}/info`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    info = await resp.json();
  } catch (err) {
    filePath = '(off)';
    setStatus('?live needs: python scripts/serve.py --watch <layout.json>', 'error');
    return;
  }
  filePath = info.path;

  // Browser edits -> file. Skip the change events a file load itself causes.
  window.addEventListener('iconic:model', () => {
    if (applying) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToFile, SAVE_DEBOUNCE_MS);
  });

  // File edits -> browser.
  const events = new EventSource(`${BASE}/events`);
  events.addEventListener('change', () => { loadFromFile(); });
  events.onerror = () => setStatus('lost the dev server; is serve.py still running?', 'error');

  await loadFromFile({ initial: true });
}

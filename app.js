// =============================================================
// TremorSense: screens, sensors, tapping test, medication log,
// charts, doctor report and storage
// =============================================================
import { analyze, resample, highPass, TARGET_FS, BAND_LOW, BAND_HIGH, MAX_DISPLAY_HZ } from './dsp.js';
import { interpretTremor } from './interpret.js';
import { analyzeTaps, interpretTaps, TAP_SECONDS } from './tapping.js';

const COUNTDOWN_S = 3;
const RECORD_MS = 11000;           // 11 s: the first second is dropped while the filter settles
const LIVE_WINDOW_MS = 4000;       // how much time the live strip shows
const MAX_SAVED = 300;
const DOSE_WINDOW_H = 24;          // a test is linked to a dose taken up to 24 h before it
const KEYS = {
  results: 'tremorsense.results.v1',
  doses: 'tremorsense.doses.v1',
  name: 'tremorsense.name',
  med: 'tremorsense.med',
  hand: 'tremorsense.hand',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const POSITION_NAMES = { rest: 'Resting hand', postural: 'Arm held out' };
const HAND_NAMES = { left: 'Left', right: 'Right' };
const READY_STEPS = {
  rest: [
    'Sit in a chair and rest your hand palm-down on your thigh.',
    'Tap Start recording.',
    'Lay the phone screen-up on the back of your hand and relax.',
  ],
  postural: [
    'Sit or stand up straight.',
    'Tap Start recording, then hold the phone flat on your open palm.',
    'Stretch that arm straight out in front of you.',
  ],
};

const state = {
  position: 'rest',
  hand: readKey(KEYS.hand) || 'right',
  demo: false,
  recording: null,
  tap: null,
};

// ---------- Storage (stays on this phone) ----------
function readKey(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeKey(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } }
function loadJSON(k) { try { return JSON.parse(readKey(k)) || []; } catch { return []; } }

// Older results have no type or hand; treat them as tremor tests.
const isTremor = (r) => !r.type || r.type === 'tremor';
function loadResults() { return loadJSON(KEYS.results); }
function saveResult(r) { writeKey(KEYS.results, JSON.stringify([r, ...loadResults()].slice(0, MAX_SAVED))); }
function loadDoses() { return loadJSON(KEYS.doses).sort((a, b) => new Date(b.date) - new Date(a.date)); }
function saveDoses(d) { writeKey(KEYS.doses, JSON.stringify(d)); }

// Hours between a test and the most recent dose before it (within 24 h), or null.
function hoursSinceDose(dateIso, doses) {
  const t = new Date(dateIso).getTime();
  let best = null;
  for (const d of doses) {
    const dt = (t - new Date(d.date).getTime()) / 3600000;
    if (dt >= 0 && dt <= DOSE_WINDOW_H && (best === null || dt < best)) best = dt;
  }
  return best;
}

// ---------- Navigation ----------
const TABS = ['screen-home', 'screen-tests', 'screen-meds', 'screen-report'];
function show(id) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== id));
  window.scrollTo(0, 0);
  // The tab bar shows on the four main screens and hides during a test.
  const onTab = TABS.includes(id) || id === 'screen-history';
  $('#tabbar').hidden = !onTab;
  document.body.classList.toggle('has-tabs', onTab);
  $$('[data-tab]').forEach((b) => (b.dataset.tab === id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const renderers = {
    'screen-home': renderHome, 'screen-history': renderHistory, 'screen-report': renderReport,
    'screen-meds': renderMeds, 'screen-tests': renderTests, 'screen-tap-ready': syncHand,
  };
  if (renderers[id]) renderers[id]();
  const h = document.getElementById(id).querySelector('h1, h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go], [data-tab]');
  if (go) { stopRecording(); stopTapping(); show(go.dataset.go || go.dataset.tab); }
  const start = e.target.closest('[data-start]');
  if (start) startFromCheck(start.dataset.start);
  const pos = e.target.closest('[data-position]');
  if (pos) choosePosition(pos.dataset.position);
  const hand = e.target.closest('[data-hand]');
  if (hand) { state.hand = hand.dataset.hand; writeKey(KEYS.hand, state.hand); syncHand(); }
});
function syncHand() {
  $$('[data-hand]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hand === state.hand)));
}

// ---------- Today (home) ----------
// Daily checks, like the task list in Apple's mPower study app.
const CHECKS = [
  { key: 'rest-left', type: 'tremor', position: 'rest', hand: 'left', title: 'Resting tremor', sub: 'Left hand' },
  { key: 'rest-right', type: 'tremor', position: 'rest', hand: 'right', title: 'Resting tremor', sub: 'Right hand' },
  { key: 'tap-left', type: 'tap', hand: 'left', title: 'Tapping', sub: 'Left hand' },
  { key: 'tap-right', type: 'tap', hand: 'right', title: 'Tapping', sub: 'Right hand' },
];
const isToday = (iso) => startOfDay(new Date(iso)).getTime() === startOfDay(new Date()).getTime();
const CHECK_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5 L8.5 15 L16 6"/></svg>';

function renderHome() {
  const all = loadResults(), doses = loadDoses();
  const today = all.filter((r) => isToday(r.date)), todayDoses = doses.filter((d) => isToday(d.date));
  $('#today-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#day-count').textContent = today.length || todayDoses.length
    ? `${plural(today.length, 'test')}, ${plural(todayDoses.length, 'dose')}` : '';

  // Dose status
  if (doses.length) {
    const h = (Date.now() - new Date(doses[0].date).getTime()) / 3600000;
    $('#dose-big').textContent = h < 24 ? `Last dose ${durationText(h)} ago` : `Last dose ${agoShort(doses[0].date)}`;
    $('#dose-small').textContent = `Taken ${formatDate(doses[0].date)}${doses[0].demo ? ' (sample)' : ''}`;
  } else {
    $('#dose-big').textContent = 'No doses logged yet';
    $('#dose-small').textContent = 'Log each dose to see how your tremor changes after it.';
  }

  // Checklist
  let done = 0;
  $('#checks').innerHTML = CHECKS.map((c) => {
    const hit = today.find((r) => (c.type === 'tap' ? r.type === 'tap' : isTremor(r) && r.position === c.position) && r.hand === c.hand);
    if (hit) done++;
    const val = !hit ? 'Start ›' : c.type === 'tap' ? `${hit.rate.toFixed(1)} taps/s` : hit.summary.level === 'none' ? 'No tremor' : `${hit.peakAmp.toFixed(2)} m/s²`;
    return `<li><button class="check-row${hit ? ' done' : ''}" data-start="${c.key}">
      <span class="check-dot">${hit ? CHECK_SVG : ''}</span>
      <span><span class="check-title">${c.title}</span><span class="check-sub">${c.sub}</span></span>
      <span class="check-val">${val}</span></button></li>`;
  }).join('');
  $('#checks-progress').textContent = `${done} of ${CHECKS.length} done`;

  renderTrends(all);

  // Last tremor recording
  const last = all.filter(isTremor).find((r) => r.trace && r.trace.length);
  $('#home-trace-note').textContent = last
    ? `${POSITION_NAMES[last.position]}, ${last.hand || ''} hand, ${formatDate(last.date)}${last.demo ? ' (demo data)' : ''}. ${last.summary.level === 'none' ? 'No clear tremor.' : `${last.peakHz.toFixed(1)} Hz, ${last.peakAmp.toFixed(2)} m/s².`}`
    : 'Your next tremor test will be drawn here.';

  const hasSample = all.some((r) => r.demo) || doses.some((d) => d.demo);
  $('#sample-panel').hidden = all.length > 0 || doses.length > 0;
  $('#sample-home-clear').hidden = !hasSample;

  requestAnimationFrame(() => {
    drawDay($('#day-chart'), today, todayDoses);
    drawTrace($('#home-trace'), last ? last.trace : null);
    drawSparks();
  });
}

// Trends: latest value, change from last week, and a small chart.
const TRENDS = [
  { key: 'rest-right', label: 'Resting tremor, right hand', unit: 'm/s²', pick: (r) => isTremor(r) && r.position === 'rest' && r.hand === 'right', val: (r) => r.peakAmp, fmt: (v) => v.toFixed(2) },
  { key: 'rest-left', label: 'Resting tremor, left hand', unit: 'm/s²', pick: (r) => isTremor(r) && r.position === 'rest' && r.hand === 'left', val: (r) => r.peakAmp, fmt: (v) => v.toFixed(2) },
  { key: 'tap-right', label: 'Tapping speed, right hand', unit: 'taps/s', pick: (r) => r.type === 'tap' && r.hand === 'right', val: (r) => r.rate, fmt: (v) => v.toFixed(1) },
  { key: 'tap-left', label: 'Tapping speed, left hand', unit: 'taps/s', pick: (r) => r.type === 'tap' && r.hand === 'left', val: (r) => r.rate, fmt: (v) => v.toFixed(1) },
];
let sparkData = [];
function renderTrends(all) {
  const weekAgo = Date.now() - 7 * 86400000;
  sparkData = [];
  const rows = TRENDS.map((t) => {
    const rs = all.filter(t.pick).slice().reverse();         // oldest first
    if (rs.length < 2) return '';
    const latest = t.val(rs[rs.length - 1]);
    const thisWeek = rs.filter((r) => new Date(r.date) >= weekAgo).map(t.val);
    const before = rs.filter((r) => new Date(r.date) < weekAgo).map(t.val);
    let change;
    if (thisWeek.length && before.length) {
      const pct = ((median(thisWeek) - median(before)) / median(before)) * 100;
      change = Math.abs(pct) < 5 ? 'About the same as last week' : `${pct > 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(pct))}% from last week`;
    } else {
      change = `${plural(rs.length, 'test')} since ${formatDay(new Date(rs[0].date))}`;
    }
    sparkData.push({ id: `spark-${t.key}`, values: rs.slice(-14).map(t.val) });
    return `<li class="trend-row"><span><span class="trend-label">${t.label}</span>
      <span class="trend-value">${t.fmt(latest)}<small>${t.unit}</small></span>
      <span class="trend-change">${change}</span></span>
      <canvas id="spark-${t.key}" aria-hidden="true"></canvas></li>`;
  }).filter(Boolean);
  $('#trends').innerHTML = rows.join('') || '<li class="empty-row">Trends appear once you have 2 or more tests of the same kind. Testing at the same times each day makes changes easier to spot.</li>';
}
function drawSparks() {
  for (const { id, values } of sparkData) {
    const c = document.getElementById(id);
    if (!c) continue;
    const ctx = setupCanvas(c), W = c.clientWidth, H = c.clientHeight;
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const X = (i) => 4 + (i / (values.length - 1)) * (W - 8);
    const Y = (v) => H - 6 - ((v - lo) / span) * (H - 12);
    ctx.strokeStyle = cssVar('--pen'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); values.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.stroke();
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath(); ctx.arc(X(values.length - 1), Y(values[values.length - 1]), 4, 0, Math.PI * 2); ctx.fill();
  }
}

// My day: hours across, tremor strength up; doses as red lines (like StrivePD's day view).
function drawDay(canvas, tests, doses) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const font = getComputedStyle(document.body).fontFamily;
  const nowH = (Date.now() - startOfDay(new Date()).getTime()) / 3600000;
  const hours = [...tests, ...doses].map((x) => (new Date(x.date) - startOfDay(new Date())) / 3600000);
  const startH = Math.max(0, Math.min(6, Math.floor(Math.min(nowH, ...hours))));
  const endH = 24;
  const pad = { l: 12, r: 12, t: 26, b: 26 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const X = (h) => pad.l + ((h - startH) / (endH - startH)) * pw;
  const tremors = tests.filter(isTremor), taps = tests.filter((r) => r.type === 'tap');
  const maxA = Math.max(0.3, ...tremors.map((r) => r.peakAmp)) * 1.15;
  const Y = (a) => pad.t + ph - 14 - (a / maxA) * (ph - 14);
  ctx.clearRect(0, 0, W, H);
  ctx.font = `13px ${font}`; ctx.textAlign = 'center'; ctx.fillStyle = cssVar('--ink-soft');
  const step = W < 340 ? 6 : 3;
  for (let h = Math.ceil(startH / step) * step; h <= endH; h += step) {
    const label = h === 0 || h === 24 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
    ctx.fillText(label, Math.min(Math.max(X(h), 22), W - 24), H - 8);
  }
  // Rest of the day is shaded: it hasn't happened yet.
  if (nowH < endH) { ctx.fillStyle = cssVar('--wash'); ctx.globalAlpha = 0.7; ctx.fillRect(X(nowH), pad.t, X(endH) - X(nowH), ph); ctx.globalAlpha = 1; }
  for (const d of doses) {
    const h = (new Date(d.date) - startOfDay(new Date())) / 3600000, x = X(h);
    ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
    ctx.fillStyle = cssVar('--accent'); ctx.font = `bold 13px ${font}`;
    ctx.fillText('Dose', Math.min(Math.max(x, 20), W - 20), pad.t - 9);
  }
  for (const r of tremors) {
    const h = (new Date(r.date) - startOfDay(new Date())) / 3600000;
    const x = X(h), y = Y(r.peakAmp);
    ctx.fillStyle = cssVar('--ink'); ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 2;
    ctx.beginPath();
    if (r.position === 'postural') ctx.rect(x - 5, y - 5, 10, 10); else ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    if (r.hand === 'left') { ctx.fillStyle = cssVar('--paper'); }
    ctx.fill(); ctx.stroke();
  }
  for (const r of taps) {
    const h = (new Date(r.date) - startOfDay(new Date())) / 3600000, x = X(h), y = pad.t + ph - 4;
    ctx.fillStyle = cssVar('--ink-soft');
    ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.lineTo(x, y - 11); ctx.closePath(); ctx.fill();
  }
  // Now line
  if (nowH <= endH) {
    ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(nowH), pad.t); ctx.lineTo(X(nowH), pad.t + ph); ctx.stroke(); ctx.setLineDash([]);
    if (!doses.some((d) => Math.abs((new Date(d.date) - startOfDay(new Date())) / 3600000 - nowH) < 1.2)) {
      ctx.fillStyle = cssVar('--ink'); ctx.font = `bold 13px ${font}`;
      ctx.fillText('Now', Math.min(Math.max(X(nowH), 18), W - 18), pad.t - 9);
    }
  }
  if (!tests.length && !doses.length) {
    ctx.fillStyle = cssVar('--ink-soft'); ctx.font = `15px ${font}`;
    ctx.fillText('Tests and doses you log today show up here', W / 2, pad.t + ph / 2);
  }
}

// Start a test straight from the checklist, with the hand already chosen.
function startFromCheck(key) {
  const c = CHECKS.find((x) => x.key === key);
  if (!c) return;
  state.hand = c.hand; writeKey(KEYS.hand, c.hand); syncHand();
  if (c.type === 'tap') show('screen-tap-ready'); else choosePosition(c.position);
}

function renderTests() {
  syncHand();
  const n = loadResults().length;
  $('#history-count').textContent = n ? String(n) : 'None yet';
}

$('#home-dose').addEventListener('click', () => { logDose(new Date()); renderHome(); });
$('#other-hand-tremor').addEventListener('click', () => { flipHand(); choosePosition(state.position); });
$('#other-hand-tap').addEventListener('click', () => { flipHand(); show('screen-tap-ready'); });
function flipHand() { state.hand = state.hand === 'left' ? 'right' : 'left'; writeKey(KEYS.hand, state.hand); syncHand(); }

// A short slice of the recording, drawn like an ECG pen trace.
function drawTrace(canvas, trace) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = cssVar('--pen');
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  if (!trace || !trace.length) {
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  } else {
    const max = Math.max(0.3, ...trace.map(Math.abs));
    trace.forEach((v, i) => {
      const x = (i / (trace.length - 1)) * W;
      const y = H / 2 - (v / max) * (H / 2 - 12);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
  }
  ctx.stroke();
}

// ---------- Tremor test: position + ready ----------
function choosePosition(p) {
  state.position = p;
  $('#ready-sub').textContent = `${POSITION_NAMES[p]}, ${state.hand} hand`;
  $('#ready-steps').innerHTML = READY_STEPS[p].map((s) => `<li>${s}</li>`).join('');
  $('#ready-error').hidden = true;
  show('screen-ready');
}

$('#start-btn').addEventListener('click', async () => {
  $('#ready-error').hidden = true;
  if (!state.demo) {
    if (typeof DeviceMotionEvent === 'undefined') {
      return showError('This device doesn\'t have a motion sensor. Open TremorSense on a phone, or go back and turn on demo data.');
    }
    // iPhones only allow motion access if we ask right after a tap.
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') return showError('Motion access is turned off. Close Safari completely, open TremorSense again, and choose Allow when asked.');
      } catch {
        return showError('Motion access can only be requested on a secure (https://) page. Open TremorSense from its GitHub Pages link.');
      }
    }
  }
  startTest();
});
function showError(msg) { const e = $('#ready-error'); e.textContent = msg; e.hidden = false; }

// ---------- Sensors ----------
function startRealSensor(onSample) {
  const handler = (e) => {
    // Prefer acceleration with gravity removed; some phones only offer the raw version.
    const a = e.acceleration && e.acceleration.x != null ? e.acceleration : e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    onSample({ t: performance.now(), x: a.x, y: a.y, z: a.z });
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
// Demo data: a simulated tremor so the app can be shown on a laptop.
function startDemoSensor(onSample) {
  const f = 4 + Math.random() * 6;
  const amp = 0.15 + Math.random() * 0.4;
  const t0 = performance.now();
  const id = setInterval(() => {
    const t = performance.now();
    const s = (t - t0) / 1000;
    const tr = amp * Math.sin(2 * Math.PI * f * s);
    const n = () => (Math.random() - 0.5) * 0.04;
    onSample({ t, x: tr * 0.8 + 0.05 * Math.sin(1.2 * s) + n(), y: tr * 0.6 + n(), z: n() });
  }, 1000 / 60);
  return () => clearInterval(id);
}

// ---------- Tremor test: recording ----------
const liveBuffer = [];

function startTest() {
  show('screen-record');
  $('#timebar-fill').style.width = '0%';
  const rec = { samples: [], phase: 'countdown', stopSensor: null, timers: [], raf: 0, liveRaf: 0, wakeLock: null };
  state.recording = rec;
  liveBuffer.length = 0;
  requestWakeLock(rec);

  let gotAny = false;
  rec.stopSensor = (state.demo ? startDemoSensor : startRealSensor)((s) => {
    gotAny = true;
    liveBuffer.push(s);
    while (liveBuffer.length && s.t - liveBuffer[0].t > LIVE_WINDOW_MS) liveBuffer.shift();
    if (rec.phase === 'recording') rec.samples.push(s);
  });

  let n = COUNTDOWN_S;
  $('#record-count').textContent = n;
  $('#rec-status').textContent = state.position === 'rest' ? 'Lay the phone on your hand' : 'Hold your arm out';
  const tick = setInterval(() => {
    n--;
    if (n > 0) { $('#record-count').textContent = n; return; }
    clearInterval(tick);
    if (!gotAny) {
      stopRecording();
      show('screen-ready');
      return showError('The motion sensor didn\'t send any readings. On Android, open your browser\'s site settings and allow motion sensors, then try again.');
    }
    beginRecording(rec);
  }, 1000);
  rec.timers.push(tick);
  drawLive(rec);
}

function beginRecording(rec) {
  rec.phase = 'recording';
  rec.samples.length = 0;
  const start = performance.now();
  $('#rec-status').textContent = 'Recording. Stay relaxed.';
  const loop = () => {
    const elapsed = performance.now() - start;
    $('#record-count').textContent = Math.max(0, Math.ceil((RECORD_MS - elapsed) / 1000));
    $('#timebar-fill').style.width = `${Math.min(100, (elapsed / RECORD_MS) * 100)}%`;
    if (elapsed >= RECORD_MS) return finishRecording(rec);
    rec.raf = requestAnimationFrame(loop);
  };
  rec.raf = requestAnimationFrame(loop);
}

function finishRecording(rec) {
  const samples = rec.samples.slice();
  stopRecording();
  if (navigator.vibrate) navigator.vibrate(200); // only after recording, so it can't add fake shaking
  if (samples.length < 100) {
    show('screen-ready');
    return showError('Too few sensor readings came in (fewer than 100). Keep the screen on and try again.');
  }
  const analysis = analyze(samples);
  const result = {
    id: Date.now(),
    type: 'tremor',
    date: new Date().toISOString(),
    position: state.position,
    hand: state.hand,
    demo: state.demo,
    ...analysis,
    summary: interpretTremor(analysis, state.position),
    trace: makeTrace(samples),
  };
  saveResult(result);
  renderResult(result);
  show('screen-result');
}

// Keep 3 seconds of the filtered signal (strongest axis) for the home screen.
function makeTrace(samples) {
  const grid = resample(samples, TARGET_FS);
  const axes = ['x', 'y', 'z'].map((k) => highPass(grid[k], TARGET_FS, 1).slice(-3 * TARGET_FS));
  const energy = axes.map((a) => a.reduce((s, v) => s + v * v, 0));
  const best = axes[energy.indexOf(Math.max(...energy))];
  return Array.from(best, (v) => +v.toFixed(3));
}

function stopRecording() {
  const rec = state.recording;
  if (!rec) return;
  rec.stopSensor && rec.stopSensor();
  rec.timers.forEach(clearInterval);
  cancelAnimationFrame(rec.raf);
  cancelAnimationFrame(rec.liveRaf);
  if (rec.wakeLock) rec.wakeLock.release().catch(() => {});
  state.recording = null;
}
$('#cancel-btn').addEventListener('click', () => { stopRecording(); show('screen-ready'); });

async function requestWakeLock(rec) {
  try { if ('wakeLock' in navigator) rec.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not supported */ }
}

// Live strip: the pen draws at the right edge and the paper moves left.
function drawLive(rec) {
  const c = $('#live-trace');
  const ctx = setupCanvas(c);
  const draw = () => {
    if (state.recording !== rec) return;
    const W = c.clientWidth, H = c.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (liveBuffer.length > 2) {
      const now = liveBuffer[liveBuffer.length - 1].t;
      const mean = { x: 0, y: 0, z: 0 };
      for (const s of liveBuffer) { mean.x += s.x; mean.y += s.y; mean.z += s.z; }
      for (const k in mean) mean[k] /= liveBuffer.length;
      ctx.strokeStyle = rec.phase === 'recording' ? cssVar('--pen') : cssVar('--ink-soft');
      ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
      ctx.beginPath();
      liveBuffer.forEach((s, i) => {
        const v = (s.x - mean.x) + (s.y - mean.y) + (s.z - mean.z);
        const x = W - ((now - s.t) / LIVE_WINDOW_MS) * W;
        const y = H / 2 - Math.max(-1, Math.min(1, v / 1.2)) * (H / 2 - 10);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    rec.liveRaf = requestAnimationFrame(draw);
  };
  draw();
}

// ---------- Tremor result ----------
function renderResult(r) {
  const none = r.summary.level === 'none';
  $('#result-when').textContent = `${formatDate(r.date)}, ${r.hand} hand${r.demo ? ' (demo data)' : ''}`;
  const value = $('#reading-value');
  value.hidden = none;
  value.innerHTML = `${r.peakHz.toFixed(1)}<small>Hz</small>`;
  $('#result-headline').textContent = r.summary.headline;
  $('#result-detail').textContent = r.summary.detail;
  $('#fact-hz').textContent = none ? 'None found' : `${r.peakHz.toFixed(1)} shakes per second`;
  $('#fact-amp').textContent = `${r.peakAmp.toFixed(2)} m/s²`;
  $('#fact-pos').textContent = `${POSITION_NAMES[r.position]}, ${r.hand} hand`;
  const h = hoursSinceDose(r.date, loadDoses());
  $('#fact-dose').textContent = h === null ? 'None logged in the last day' : `${durationText(h)} before this test`;
  $('#fact-rate').textContent = `${r.sampleRateHz} readings per second`;
  requestAnimationFrame(() => drawSpectrum($('#spectrum'), r));
}

function drawSpectrum(canvas, r) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const pad = { l: 20, r: 20, t: 34, b: 30 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const maxA = Math.max(0.1, ...r.amplitude) * 1.15;
  const X = (f) => pad.l + (f / MAX_DISPLAY_HZ) * pw;
  const Y = (a) => pad.t + ph - (a / maxA) * ph;
  const font = getComputedStyle(document.body).fontFamily;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--paper');
  ctx.fillRect(0, 0, W, H);
  for (let f = 0; f <= MAX_DISPLAY_HZ; f++) {
    ctx.strokeStyle = cssVar(f % 5 === 0 ? '--grid-major' : '--grid-minor');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(X(f)) + 0.5, pad.t); ctx.lineTo(Math.round(X(f)) + 0.5, pad.t + ph); ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(pad.t + (ph * i) / 4) + 0.5;
    ctx.strokeStyle = cssVar('--grid-minor');
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
  }
  ctx.fillStyle = cssVar('--band-a'); ctx.fillRect(X(BAND_LOW), pad.t, X(7) - X(BAND_LOW), ph);
  ctx.fillStyle = cssVar('--band-b'); ctx.fillRect(X(7), pad.t, X(BAND_HIGH) - X(7), ph);
  ctx.fillStyle = cssVar('--ink-soft');
  ctx.font = `15px ${font}`; ctx.textAlign = 'center';
  ctx.fillText('3–7 Hz', (X(BAND_LOW) + X(7)) / 2, pad.t - 10);
  ctx.fillText('7–12 Hz', (X(7) + X(BAND_HIGH)) / 2, pad.t - 10);
  for (let f = 0; f <= MAX_DISPLAY_HZ; f += 5) ctx.fillText(f === MAX_DISPLAY_HZ ? '20 Hz' : String(f), Math.min(X(f), W - 22), H - 8);

  ctx.beginPath();
  r.freqs.forEach((f, i) => { const x = X(f), y = Y(r.amplitude[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = cssVar('--pen'); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

  if (r.summary.level !== 'none') {
    const px = X(r.peakHz), py = Y(r.peakAmp);
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cssVar('--ink');
    ctx.font = `bold 16px ${font}`;
    ctx.textAlign = px > W - 90 ? 'right' : 'left';
    ctx.fillText(`${r.peakHz.toFixed(1)} Hz`, px + (ctx.textAlign === 'left' ? 11 : -11), Math.max(py + 5, pad.t + 14));
  }
}

// ---------- Tapping test ----------
$('#tap-start-btn').addEventListener('click', () => startTapping());
$('#tap-cancel').addEventListener('click', () => { stopTapping(); show('screen-tap-ready'); });

function startTapping() {
  const t = { taps: [], start: 0, last: null, timer: 0, raf: 0, done: false };
  state.tap = t;
  $('#tap-count').textContent = TAP_SECONDS;
  $('#tap-tally').textContent = '0';
  $('#tap-status').textContent = 'Tap either circle to start';
  $('#tap-timebar').style.width = '0%';
  $$('.tap-target').forEach((b) => { b.classList.add('next'); b.disabled = false; });
  show('screen-tap');
}

// pointerdown reacts the instant a finger touches, with no delay.
$('#tap-pad').addEventListener('pointerdown', (e) => {
  const t = state.tap;
  if (!t || t.done) return;
  e.preventDefault();
  const target = e.target.closest('.tap-target');
  const now = performance.now();
  if (!t.start) {
    if (!target) return;             // the clock starts with the first tap on a circle
    t.start = now;
    $('#tap-status').textContent = 'Keep going';
    runTapClock(t);
  }
  const ms = now - t.start;
  if (!target) { t.taps.push({ t: ms, valid: false, miss: true }); return; }
  const which = +target.dataset.target;
  const valid = which !== t.last;    // only alternating taps count
  t.taps.push({ t: ms, valid, miss: false });
  if (valid) t.last = which;
  $('#tap-tally').textContent = t.taps.filter((x) => x.valid).length;
  $$('.tap-target').forEach((b) => b.classList.toggle('next', +b.dataset.target !== t.last));
  target.classList.add('hit');
  setTimeout(() => target.classList.remove('hit'), 80);
});

function runTapClock(t) {
  const loop = () => {
    if (state.tap !== t) return;
    const elapsed = performance.now() - t.start;
    $('#tap-count').textContent = Math.max(0, Math.ceil(TAP_SECONDS - elapsed / 1000));
    $('#tap-timebar').style.width = `${Math.min(100, (elapsed / (TAP_SECONDS * 1000)) * 100)}%`;
    if (elapsed >= TAP_SECONDS * 1000) return finishTapping(t);
    t.raf = requestAnimationFrame(loop);
  };
  t.raf = requestAnimationFrame(loop);
}

function finishTapping(t) {
  t.done = true;
  $$('.tap-target').forEach((b) => { b.disabled = true; b.classList.remove('next'); });
  const taps = t.taps.filter((x) => x.t < TAP_SECONDS * 1000);
  stopTapping();
  if (navigator.vibrate) navigator.vibrate(200);
  const analysis = analyzeTaps(taps);
  const result = {
    id: Date.now(),
    type: 'tap',
    date: new Date().toISOString(),
    hand: state.hand,
    demo: false,
    ...analysis,
    summary: interpretTaps(analysis),
  };
  if (analysis.taps >= 5) saveResult(result);
  renderTapResult(result);
  show('screen-tap-result');
}

function stopTapping() {
  const t = state.tap;
  if (!t) return;
  cancelAnimationFrame(t.raf);
  state.tap = null;
}

function renderTapResult(r) {
  $('#tap-when').textContent = `${formatDate(r.date)}, ${r.hand} hand`;
  const enough = r.taps >= 5;
  $('#tap-value').hidden = !enough;
  $('#tap-value').innerHTML = `${r.rate.toFixed(1)}<small>taps/s</small>`;
  $('#tap-headline').textContent = enough ? 'Tapping speed' : r.summary.headline;
  $('#tap-detail').textContent = r.summary.detail;
  $('#tfact-taps').textContent = `${r.taps} in ${TAP_SECONDS} seconds`;
  $('#tfact-cv').textContent = `${r.cvPct}% (lower is steadier)`;
  $('#tfact-slow').textContent = slowdownText(r.slowdownPct);
  $('#tfact-miss').textContent = `${r.misses} outside the circles, ${r.repeats} repeated`;
  $('#tfact-hand').textContent = `${HAND_NAMES[r.hand]} hand`;
  requestAnimationFrame(() => drawTapChart($('#tap-chart'), r));
}

function slowdownText(p) {
  if (Math.abs(p) < 5) return 'About the same speed throughout';
  return p > 0 ? `${Math.round(p)}% slower at the end` : `${Math.round(-p)}% faster at the end`;
}

function drawTapChart(canvas, r) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const pad = { l: 68, r: 16, t: 14, b: 30 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const font = getComputedStyle(document.body).fontFamily;
  const maxMs = Math.max(400, ...r.intervals.map((x) => x.ms)) * 1.1;
  const X = (t) => pad.l + (t / (TAP_SECONDS * 1000)) * pw;
  const Y = (ms) => pad.t + ph - (ms / maxMs) * ph;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--paper'); ctx.fillRect(0, 0, W, H);
  ctx.font = `14px ${font}`;
  for (let i = 0; i <= 4; i++) {
    const v = (maxMs * i) / 4, y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = cssVar(i === 0 ? '--grid-major' : '--grid-minor'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.fillStyle = cssVar('--ink-soft'); ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(v)} ms`, pad.l - 8, y + 5);
  }
  ctx.textAlign = 'center';
  for (let s = 0; s <= TAP_SECONDS; s += 5) ctx.fillText(s === TAP_SECONDS ? '15 s' : String(s), Math.min(X(s * 1000), W - 18), H - 8);
  // Trend line (least squares) shows whether taps got slower.
  if (r.intervals.length > 3) {
    const n = r.intervals.length;
    const mx = r.intervals.reduce((a, p) => a + p.t, 0) / n;
    const my = r.intervals.reduce((a, p) => a + p.ms, 0) / n;
    const sxy = r.intervals.reduce((a, p) => a + (p.t - mx) * (p.ms - my), 0);
    const sxx = r.intervals.reduce((a, p) => a + (p.t - mx) ** 2, 0) || 1;
    const slope = sxy / sxx, b0 = my - slope * mx;
    ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(0), Y(b0)); ctx.lineTo(X(TAP_SECONDS * 1000), Y(b0 + slope * TAP_SECONDS * 1000)); ctx.stroke();
  }
  ctx.fillStyle = cssVar('--pen');
  for (const p of r.intervals) { ctx.beginPath(); ctx.arc(X(p.t), Y(p.ms), 4, 0, Math.PI * 2); ctx.fill(); }
}

// ---------- Medication log ----------
$('#dose-now').addEventListener('click', () => logDose(new Date()));
$('#dose-earlier').addEventListener('click', () => {
  const v = $('#dose-time').value;
  if (!v) { $('#dose-time').focus(); return; }
  const [h, m] = v.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d > new Date()) d.setDate(d.getDate() - 1); // a time later than now means yesterday
  logDose(d);
});
$('#med-name').addEventListener('input', (e) => writeKey(KEYS.med, e.target.value));

function logDose(date) {
  const dose = { id: Date.now(), date: date.toISOString(), demo: false };
  saveDoses([dose, ...loadDoses()]);
  const c = $('#dose-confirm');
  c.innerHTML = `Dose logged for ${formatDate(dose.date)}. <button class="dose-remove" data-undo="${dose.id}">Undo</button>`;
  c.hidden = false;
  renderMeds();
}
document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove-dose], [data-undo]');
  if (!rm) return;
  const id = +(rm.dataset.removeDose || rm.dataset.undo);
  saveDoses(loadDoses().filter((d) => d.id !== id));
  if (rm.dataset.undo) $('#dose-confirm').hidden = true;
  renderMeds();
});

function renderMeds() {
  const doses = loadDoses();
  $('#med-name').value = readKey(KEYS.med) || '';
  $('#dose-empty').hidden = doses.length > 0;
  $('#dose-list').innerHTML = doses.slice(0, 20).map((d) => `
    <li><span><span class="h-pos">${formatDate(d.date)}</span><span class="h-when">${agoText(d.date)}${d.demo ? ' (sample)' : ''}</span></span>
    <button class="dose-remove" data-remove-dose="${d.id}">Remove</button></li>`).join('');
}

// ---------- History ----------
function renderHistory() {
  const all = loadResults();
  $('#history-empty').hidden = all.length > 0;
  $('#history-list').innerHTML = all.map((r) => {
    const hand = r.hand ? `, ${r.hand} hand` : '';
    if (r.type === 'tap') {
      return `<li><span><span class="h-when">${formatDate(r.date)}${r.demo ? ' (sample)' : ''}</span>
        <span class="h-pos">Tapping${hand}</span></span>
        <span class="h-val">${r.rate.toFixed(1)} taps/s<small>${slowdownText(r.slowdownPct)}</small></span></li>`;
    }
    return `<li><span><span class="h-when">${formatDate(r.date)}${r.demo ? ' (demo)' : ''}</span>
      <span class="h-pos">${POSITION_NAMES[r.position]}${hand}</span></span>
      <span class="h-val">${r.summary.level === 'none' ? 'None' : `${r.peakHz.toFixed(1)} Hz`}<small>${r.peakAmp.toFixed(2)} m/s²</small></span></li>`;
  }).join('');
}

// ---------- Doctor report ----------
function reportData() {
  const all = loadResults(), doses = loadDoses();
  const real = all.filter((r) => !r.demo), realDoses = doses.filter((d) => !d.demo);
  const useDemo = real.length === 0 && all.length > 0;  // demo data only if that's all there is
  const list = (useDemo ? all : real).slice().reverse();
  const doseList = (useDemo ? doses : realDoses).slice().reverse();
  return { list, doses: doseList, isDemo: useDemo };
}

const median = (nums) => {
  const s = nums.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function renderReport() {
  const { list, doses, isDemo } = reportData();
  $('#report-made').textContent = `Made ${formatDate(new Date().toISOString())}${isDemo ? '. Contains sample data only, not a real patient.' : ''}`;
  $('#report-name').value = readKey(KEYS.name) || '';
  $('#report-empty').hidden = list.length > 0;
  $('#report-body').hidden = list.length === 0;
  $('#sample-fill').hidden = list.length > 0;
  $('#sample-clear').hidden = !loadResults().some((r) => r.demo);
  if (!list.length) return;

  const tremors = list.filter(isTremor), taps = list.filter((r) => r.type === 'tap');
  const times = [...list, ...doses].map((x) => new Date(x.date).getTime());
  const first = new Date(Math.min(...times)), last = new Date(Math.max(...times));
  const days = Math.round((startOfDay(last) - startOfDay(first)) / 86400000) + 1;
  const parts = [plural(tremors.length, 'tremor test'), plural(taps.length, 'tapping test'), plural(doses.length, 'logged dose')].filter((p) => !p.startsWith('0 '));
  const med = readKey(KEYS.med);
  $('#report-span').textContent = `${joinList(parts)} over ${plural(days, 'day')}, ${formatDay(first)} to ${formatDay(last)}.${med ? ` Medication: ${med}.` : ''}`;

  // Tremor summary, per test position and hand
  const groups = [];
  for (const pos of ['rest', 'postural']) for (const hand of ['left', 'right', undefined]) {
    const rs = tremors.filter((r) => r.position === pos && r.hand === hand);
    if (rs.length) groups.push({ pos, hand, rs });
  }
  $('#report-summary').innerHTML = groups.map(({ pos, hand, rs }) => {
    const withTremor = rs.filter((r) => r.summary.level !== 'none');
    const hz = withTremor.length ? `${median(withTremor.map((r) => r.peakHz)).toFixed(1)} Hz` : 'None found';
    return `<tr><td>${POSITION_NAMES[pos]}</td><td>${hand ? HAND_NAMES[hand] : '–'}</td><td>${rs.length}</td><td>${hz}</td><td>${median(rs.map((r) => r.peakAmp)).toFixed(2)} m/s²</td></tr>`;
  }).join('') || '<tr><td colspan="5">No tremor tests yet</td></tr>';

  // Left vs right
  const sides = [];
  for (const pos of ['rest', 'postural']) {
    const L = tremors.filter((r) => r.position === pos && r.hand === 'left');
    const R = tremors.filter((r) => r.position === pos && r.hand === 'right');
    if (!L.length || !R.length) continue;
    const l = median(L.map((r) => r.peakAmp)), rr = median(R.map((r) => r.peakAmp));
    const ratio = Math.max(l, rr) / Math.max(0.001, Math.min(l, rr));
    const label = pos === 'rest' ? 'Resting tremor' : 'Arm-held-out tremor';
    sides.push(ratio < 1.25
      ? `${label} is about the same in both hands.`
      : `${label} is typically ${ratio.toFixed(1)} times stronger in the ${rr > l ? 'right' : 'left'} hand.`);
  }
  $('#report-sides').textContent = sides.join(' ');
  $('#report-sides').hidden = !sides.length;

  // After each dose
  const linked = tremors.map((r) => ({ r, h: hoursSinceDose(r.date, doses) })).filter((x) => x.h !== null);
  $('#dose-block').hidden = !doses.length;
  const enough = linked.length >= 3;
  $('#dose-fig').hidden = !enough;
  $('#dose-help').hidden = !enough;
  if (!enough) {
    $('#dose-finding').textContent = 'Fewer than 3 tremor tests were taken within a day after a logged dose, so there isn\'t enough data to show a pattern yet.';
  } else {
    const early = linked.filter((x) => x.h < 3).map((x) => x.r.peakAmp);
    const late = linked.filter((x) => x.h >= 3).map((x) => x.r.peakAmp);
    if (early.length >= 2 && late.length >= 2) {
      const a = median(early), b = median(late), change = ((b - a) / a) * 100;
      $('#dose-finding').textContent = Math.abs(change) < 10
        ? `Tremor strength was about the same within 3 hours of a dose (typically ${a.toFixed(2)} m/s²) as 3 or more hours after (${b.toFixed(2)} m/s²).`
        : `Tremor was typically ${Math.round(Math.abs(change))}% ${change > 0 ? 'stronger' : 'weaker'} 3 or more hours after a dose (${b.toFixed(2)} m/s²) than within 3 hours of it (${a.toFixed(2)} m/s²).`;
    } else {
      $('#dose-finding').textContent = 'To compare, the report needs at least 2 tests within 3 hours of a dose and 2 tests later than that.';
    }
    requestAnimationFrame(() => drawDoseChart($('#dose-chart'), linked));
  }

  // Tapping summary per hand
  $('#tap-block').hidden = !taps.length;
  $('#report-taps').innerHTML = ['left', 'right'].map((hand) => {
    const rs = taps.filter((r) => r.hand === hand);
    if (!rs.length) return '';
    return `<tr><td>${HAND_NAMES[hand]}</td><td>${rs.length}</td><td>${median(rs.map((r) => r.rate)).toFixed(1)} taps/s</td>
      <td>${median(rs.map((r) => r.cvPct)).toFixed(0)}%</td><td>${slowdownText(median(rs.map((r) => r.slowdownPct)))}</td></tr>`;
  }).join('');

  // Every entry, newest first, doses mixed in
  const entries = [...list.map((r) => ({ kind: 'test', r, date: r.date })), ...doses.map((d) => ({ kind: 'dose', date: d.date }))]
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  $('#report-rows').innerHTML = entries.map((e) => {
    if (e.kind === 'dose') return `<tr class="dose-row"><td>${formatDate(e.date)}</td><td>Dose taken</td><td>–</td><td>–</td><td>–</td></tr>`;
    const r = e.r, h = hoursSinceDose(r.date, doses);
    const after = h === null ? '–' : durationText(h);
    const tag = r.demo ? ' (sample)' : '';
    if (r.type === 'tap') return `<tr><td>${formatDate(r.date)}${tag}</td><td>Tapping</td><td>${r.hand ? HAND_NAMES[r.hand] : '–'}</td><td>${r.rate.toFixed(1)} taps/s</td><td>${after}</td></tr>`;
    return `<tr><td>${formatDate(r.date)}${tag}</td><td>${POSITION_NAMES[r.position]}</td><td>${r.hand ? HAND_NAMES[r.hand] : '–'}</td>
      <td>${r.summary.level === 'none' ? 'No clear tremor' : `${r.peakHz.toFixed(1)} Hz, ${r.peakAmp.toFixed(2)} m/s²`}</td><td>${after}</td></tr>`;
  }).join('');

  requestAnimationFrame(() => drawTrend($('#trend'), tremors, doses));
}

// One mark per test: shape = position, filled = right hand, open = left.
function drawMark(ctx, x, y, r) {
  const color = cssVar(r.hand === 'left' ? '--ink' : '--accent');
  ctx.lineWidth = 2; ctx.strokeStyle = color;
  ctx.fillStyle = r.hand === 'left' ? cssVar('--paper') : color;
  ctx.beginPath();
  if (r.position === 'postural') ctx.rect(x - 5, y - 5, 10, 10); else ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
}

function chartFrame(canvas, maxY, yLabel) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const pad = { l: 52, r: 18, t: 16, b: 30 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const font = getComputedStyle(document.body).fontFamily;
  const Y = (v) => pad.t + ph - (v / maxY) * ph;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--paper'); ctx.fillRect(0, 0, W, H);
  ctx.font = `14px ${font}`;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY * i) / 4, y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = cssVar(i === 0 ? '--grid-major' : '--grid-minor'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.fillStyle = cssVar('--ink-soft'); ctx.textAlign = 'right'; ctx.fillText(yLabel(v), pad.l - 8, y + 5);
  }
  return { ctx, W, H, pad, pw, ph, Y };
}

function drawTrend(canvas, tremors, doses) {
  if (!tremors.length) { setupCanvas(canvas); return; }
  const times = [...tremors, ...doses].map((x) => new Date(x.date).getTime());
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const maxA = Math.max(0.2, ...tremors.map((r) => r.peakAmp)) * 1.15;
  const { ctx, W, H, pad, pw, ph, Y } = chartFrame(canvas, maxA, (v) => v.toFixed(2));
  const X = (d) => (t1 === t0 ? pad.l + pw / 2 : pad.l + ((new Date(d).getTime() - t0) / (t1 - t0)) * pw);
  ctx.fillStyle = cssVar('--ink-soft');
  ctx.textAlign = 'left'; ctx.fillText(formatDay(new Date(t0)), pad.l, H - 8);
  if (t1 !== t0) { ctx.textAlign = 'right'; ctx.fillText(formatDay(new Date(t1)), pad.l + pw, H - 8); }
  ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 2.5;
  for (const d of doses) { const x = X(d.date); ctx.beginPath(); ctx.moveTo(x, pad.t + ph); ctx.lineTo(x, pad.t + ph - 10); ctx.stroke(); }
  for (const r of tremors) drawMark(ctx, X(r.date), Y(r.peakAmp), r);
}

function drawDoseChart(canvas, linked) {
  const maxH = Math.max(6, Math.ceil(Math.max(...linked.map((x) => x.h))));
  const maxA = Math.max(0.2, ...linked.map((x) => x.r.peakAmp)) * 1.15;
  const { ctx, H, pad, pw, ph, Y } = chartFrame(canvas, maxA, (v) => v.toFixed(2));
  const X = (h) => pad.l + (h / maxH) * pw;
  ctx.textAlign = 'center'; ctx.fillStyle = cssVar('--ink-soft');
  const step = maxH > 12 ? 4 : 2;
  for (let h = 0; h <= maxH; h += step) {
    ctx.strokeStyle = cssVar('--grid-minor'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(X(h)) + 0.5, pad.t); ctx.lineTo(Math.round(X(h)) + 0.5, pad.t + ph); ctx.stroke();
    ctx.fillText(h === 0 ? 'dose' : `${h} h`, X(h), H - 8);
  }
  for (const { r, h } of linked) drawMark(ctx, X(h), Y(r.peakAmp), r);
}

$('#report-name').addEventListener('input', (e) => writeKey(KEYS.name, e.target.value));
$('#print-btn').addEventListener('click', () => window.print());
// Charts are sized for the screen; redraw at print size, then back.
window.addEventListener('beforeprint', () => { if (!$('#screen-report').hidden) renderReport(); });
window.addEventListener('afterprint', () => { if (!$('#screen-report').hidden) renderReport(); });

// ---------- Sample data (demo mode only) ----------
// Lets judges and viewers see a full report without a week of testing.
// Every sample entry is marked demo: true and labeled "sample" everywhere.
function loadSample() {
  const results = [], doses = [];
  const day0 = startOfDay(new Date()).getTime() - 6 * 86400000;
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = 0; d < 7; d++) {
    for (const doseHour of [8, 14]) doses.push({ id: day0 + d * 86400000 + doseHour * 3600000, date: new Date(day0 + d * 86400000 + doseHour * 3600000).toISOString(), demo: true });
    // Tests at different times after the morning dose: tremor grows as the dose wears off.
    for (const [hoursAfter, hand, pos] of [[1, 'right', 'rest'], [1.2, 'left', 'rest'], [4.5, 'right', 'rest'], [4.7, 'left', 'rest'], [2, 'right', 'postural'], [5.5, 'right', 'postural']]) {
      const jitter = (rand() - 0.5) * 1.2;
      const t = day0 + d * 86400000 + (8 + hoursAfter + jitter) * 3600000;
      if (t > Date.now()) continue;
      const base = hand === 'right' ? 0.22 : 0.09;
      const amp = +(base * (pos === 'postural' ? 0.7 : 1) * (1 + 0.28 * (hoursAfter + jitter)) * (0.85 + 0.3 * rand())).toFixed(3);
      results.push({ id: t, type: 'tremor', date: new Date(t).toISOString(), position: pos, hand, demo: true,
        peakHz: +(pos === 'rest' ? 4.6 + rand() * 0.8 : 5.6 + rand() * 0.8).toFixed(2), peakAmp: amp, sampleRateHz: 60,
        bandRatio: 0.8, freqs: [], amplitude: [],
        trace: Array.from({ length: 150 }, (_, i) => +(amp * Math.sin(2 * Math.PI * 5 * i / 50) + (rand() - 0.5) * 0.03).toFixed(3)),
        summary: interpretTremor({ peakHz: 5, peakAmp: amp, bandRatio: 0.8 }, pos) });
    }
    for (const hand of ['left', 'right']) {
      const t = day0 + d * 86400000 + 13 * 3600000 + rand() * 600000;
      if (t > Date.now()) continue;
      const rate = hand === 'right' ? 3.6 + rand() * 0.5 : 4.9 + rand() * 0.5;
      results.push({ id: t + 1, type: 'tap', date: new Date(t).toISOString(), hand, demo: true, taps: Math.round(rate * 15), rate: +rate.toFixed(2),
        cvPct: +(hand === 'right' ? 22 + rand() * 8 : 9 + rand() * 4).toFixed(1), slowdownPct: +(hand === 'right' ? 18 + rand() * 10 : 2 + rand() * 4).toFixed(1),
        misses: 0, repeats: 0, intervals: [], summary: { headline: '', detail: '' } });
    }
  }
  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  writeKey(KEYS.results, JSON.stringify([...loadResults(), ...results].slice(0, MAX_SAVED)));
  saveDoses([...loadDoses(), ...doses]);
}
$('#sample-fill').addEventListener('click', () => { loadSample(); renderReport(); });
$('#sample-home').addEventListener('click', () => { loadSample(); renderHome(); });
$('#sample-home-clear').addEventListener('click', () => { clearSample(); renderHome(); });
function clearSample() {
  writeKey(KEYS.results, JSON.stringify(loadResults().filter((r) => !r.demo)));
  saveDoses(loadDoses().filter((d) => !d.demo));
}
$('#sample-clear').addEventListener('click', () => { clearSample(); renderReport(); });

// ---------- Helpers ----------
function formatDate(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function formatDay(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function durationText(h) {
  const total = Math.round(h * 60), hh = Math.floor(total / 60), mm = total % 60;
  if (hh === 0) return `${mm} min`;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
function agoText(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1 / 60) return 'just now';
  if (h < 24) return `${durationText(h)} ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}
function agoShort(iso) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (h < 1) return `${Math.max(0, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function joinList(a) { return a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(c.clientHeight * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ---------- Demo data toggle ----------
$('#demo-toggle').addEventListener('click', () => {
  state.demo = !state.demo;
  document.body.classList.toggle('demo', state.demo);
  $('#demo-toggle').textContent = state.demo ? 'Turn off demo data' : 'Try it without a phone (demo data)';
  let flag = document.querySelector('.demo-flag');
  if (state.demo && !flag) {
    flag = document.createElement('p');
    flag.className = 'demo-flag';
    flag.textContent = 'Demo data: results are simulated';
    document.body.appendChild(flag);
  } else if (!state.demo && flag) flag.remove();
});

// Redraw charts if the phone is rotated
window.addEventListener('resize', () => { if (!$('#screen-home').hidden) renderHome(); else if (!$('#screen-report').hidden) renderReport(); });

// ---------- Install / offline ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

syncHand();
show('screen-home');

// =============================================================
// TremorSense: screens, sensor recording, charts, storage
// =============================================================
import { analyze, resample, highPass, TARGET_FS, BAND_LOW, BAND_HIGH, MAX_DISPLAY_HZ } from './dsp.js';
import { interpretTremor } from './interpret.js';

const COUNTDOWN_S = 3;
const RECORD_MS = 11000;           // 11 s: the first second is dropped while the filter settles
const STORAGE_KEY = 'tremorsense.results.v1';
const MAX_SAVED = 100;
const LIVE_WINDOW_MS = 4000;       // how much time the live strip shows

const $ = (sel) => document.querySelector(sel);
const POSITION_NAMES = { rest: 'Resting hand', postural: 'Arm held out' };
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

const state = { position: 'rest', demo: false, recording: null };

// ---------- Navigation ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== id));
  window.scrollTo(0, 0);
  if (id === 'screen-home') renderHome();
  if (id === 'screen-history') renderHistory();
  if (id === 'screen-report') renderReport();
  const h = document.getElementById(id).querySelector('h1, h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { stopRecording(); show(go.dataset.go); }
  const pos = e.target.closest('[data-position]');
  if (pos) choosePosition(pos.dataset.position);
});

// ---------- Storage (stays on this phone) ----------
function loadResults() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function saveResult(r) {
  const all = [r, ...loadResults()].slice(0, MAX_SAVED);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
}

// ---------- Home ----------
function renderHome() {
  const all = loadResults();
  $('#history-count').textContent = all.length ? String(all.length) : 'None yet';
  const last = all[0];
  if (!last) {
    $('#last-line').textContent = 'Your first test takes about 30 seconds.';
    $('#home-trace-note').textContent = 'No recordings yet';
    requestAnimationFrame(() => drawTrace($('#home-trace'), null));
    return;
  }
  $('#last-line').innerHTML = last.summary.level === 'none'
    ? `Last result: <strong>no clear tremor</strong> (${POSITION_NAMES[last.position].toLowerCase()})`
    : `Last result: <strong>${last.peakHz.toFixed(1)} Hz</strong> (${POSITION_NAMES[last.position].toLowerCase()})`;
  $('#home-trace-note').textContent = `Recorded ${formatDate(last.date)}${last.demo ? ', demo data' : ''}`;
  requestAnimationFrame(() => drawTrace($('#home-trace'), last.trace));
}

// A short slice of the recording, drawn like a pen trace.
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

// ---------- Position + ready ----------
function choosePosition(p) {
  state.position = p;
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
    onSample({ t, x: tr * 0.8 + 0.3 * Math.sin(1.2 * s) + n(), y: tr * 0.6 + n(), z: 9.81 + n() });
  }, 1000 / 60);
  return () => clearInterval(id);
}

// ---------- The test ----------
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
    date: new Date().toISOString(),
    position: state.position,
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

// ---------- Results ----------
function renderResult(r) {
  const none = r.summary.level === 'none';
  $('#result-when').textContent = `${formatDate(r.date)}${r.demo ? ' (demo data)' : ''}`;
  const value = $('#reading-value');
  value.hidden = none;
  value.innerHTML = `${r.peakHz.toFixed(1)}<small>Hz</small>`;
  $('#result-headline').textContent = r.summary.headline;
  $('#result-detail').textContent = r.summary.detail;
  $('#fact-hz').textContent = none ? 'None found' : `${r.peakHz.toFixed(1)} shakes per second`;
  $('#fact-amp').textContent = `${r.peakAmp.toFixed(2)} m/s²`;
  $('#fact-pos').textContent = POSITION_NAMES[r.position];
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

  // Grid: a thin line every 1 Hz, a darker one every 5 Hz
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

  // Tremor bands, labeled directly
  ctx.fillStyle = cssVar('--band-a'); ctx.fillRect(X(BAND_LOW), pad.t, X(7) - X(BAND_LOW), ph);
  ctx.fillStyle = cssVar('--band-b'); ctx.fillRect(X(7), pad.t, X(BAND_HIGH) - X(7), ph);
  ctx.fillStyle = cssVar('--ink-soft');
  ctx.font = `15px ${font}`; ctx.textAlign = 'center';
  ctx.fillText('3–7 Hz', (X(BAND_LOW) + X(7)) / 2, pad.t - 10);
  ctx.fillText('7–12 Hz', (X(7) + X(BAND_HIGH)) / 2, pad.t - 10);

  // Axis numbers
  for (let f = 0; f <= MAX_DISPLAY_HZ; f += 5) ctx.fillText(f === MAX_DISPLAY_HZ ? '20 Hz' : String(f), Math.min(X(f), W - 22), H - 8);

  // The pen line
  ctx.beginPath();
  r.freqs.forEach((f, i) => { const x = X(f), y = Y(r.amplitude[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = cssVar('--pen'); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

  // Peak marker
  if (r.summary.level !== 'none') {
    const px = X(r.peakHz), py = Y(r.peakAmp);
    ctx.fillStyle = cssVar('--ink');
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = `bold 16px ${font}`;
    ctx.textAlign = px > W - 90 ? 'right' : 'left';
    ctx.fillText(`${r.peakHz.toFixed(1)} Hz`, px + (ctx.textAlign === 'left' ? 10 : -10), Math.max(py + 5, pad.t + 14));
  }
}

// ---------- History ----------
function renderHistory() {
  const all = loadResults();
  $('#history-empty').hidden = all.length > 0;
  $('#history-list').innerHTML = all.map((r) => `
    <li>
      <span>
        <span class="h-when">${formatDate(r.date)}${r.demo ? ' (demo)' : ''}</span>
        <span class="h-pos">${POSITION_NAMES[r.position]}</span>
      </span>
      <span class="h-val">${r.summary.level === 'none' ? 'None' : `${r.peakHz.toFixed(1)} Hz`}
        <small>${r.peakAmp.toFixed(2)} m/s²</small></span>
    </li>`).join('');
}

// ---------- Doctor report ----------
const NAME_KEY = 'tremorsense.name';

function reportResults() {
  const all = loadResults();
  const real = all.filter((r) => !r.demo);
  // Use real tests only, unless demo data is all there is.
  return { list: (real.length ? real : all).slice().reverse(), isDemo: real.length === 0 && all.length > 0 };
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function renderReport() {
  const { list, isDemo } = reportResults();
  $('#report-made').textContent = `Made ${formatDate(new Date().toISOString())}${isDemo ? '. Contains demo data only.' : ''}`;
  try { $('#report-name').value = localStorage.getItem(NAME_KEY) || ''; } catch { /* storage blocked */ }
  $('#report-empty').hidden = list.length > 0;
  $('#report-body').hidden = list.length === 0;
  if (!list.length) return;

  const first = new Date(list[0].date), last = new Date(list[list.length - 1].date);
  const days = Math.round((last - first) / 86400000) + 1;
  $('#report-span').textContent =
    `${list.length} test${list.length > 1 ? 's' : ''} over ${days} day${days > 1 ? 's' : ''}, from ${formatDay(first)} to ${formatDay(last)}.`;

  // Summary per test position. "Typical" = median, so one odd test doesn't skew it.
  $('#report-summary').innerHTML = ['rest', 'postural'].map((pos) => {
    const rs = list.filter((r) => r.position === pos);
    if (!rs.length) return `<tr><td>${POSITION_NAMES[pos]}</td><td>0</td><td>–</td><td>–</td><td>–</td></tr>`;
    const withTremor = rs.filter((r) => r.summary.level !== 'none');
    const hz = withTremor.length ? `${median(withTremor.map((r) => r.peakHz)).toFixed(1)} Hz` : 'None found';
    const recent = rs[rs.length - 1];
    return `<tr><td>${POSITION_NAMES[pos]}</td><td>${rs.length}</td><td>${hz}</td>
      <td>${median(rs.map((r) => r.peakAmp)).toFixed(2)} m/s²</td>
      <td>${recent.summary.level === 'none' ? 'No clear tremor' : `${recent.peakHz.toFixed(1)} Hz, ${recent.peakAmp.toFixed(2)} m/s²`}</td></tr>`;
  }).join('');

  $('#report-rows').innerHTML = list.slice().reverse().map((r) => `
    <tr><td>${formatDate(r.date)}${r.demo ? ' (demo)' : ''}</td><td>${POSITION_NAMES[r.position]}</td>
    <td>${r.summary.level === 'none' ? 'None' : `${r.peakHz.toFixed(1)} Hz`}</td><td>${r.peakAmp.toFixed(2)} m/s²</td></tr>`).join('');

  requestAnimationFrame(() => drawTrend($('#trend'), list));
}

// Strength of each test, in time order.
function drawTrend(canvas, list) {
  const ctx = setupCanvas(canvas);
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const pad = { l: 52, r: 20, t: 16, b: 30 };
  const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  const font = getComputedStyle(document.body).fontFamily;
  const t0 = new Date(list[0].date).getTime();
  const t1 = new Date(list[list.length - 1].date).getTime();
  const maxA = Math.max(0.2, ...list.map((r) => r.peakAmp)) * 1.15;
  const X = (r) => (t1 === t0 ? pad.l + pw / 2 : pad.l + ((new Date(r.date).getTime() - t0) / (t1 - t0)) * pw);
  const Y = (a) => pad.t + ph - (a / maxA) * ph;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--paper'); ctx.fillRect(0, 0, W, H);
  ctx.font = `14px ${font}`; ctx.fillStyle = cssVar('--ink-soft');
  for (let i = 0; i <= 4; i++) {
    const a = (maxA * i) / 4, y = Math.round(Y(a)) + 0.5;
    ctx.strokeStyle = cssVar(i === 0 ? '--grid-major' : '--grid-minor'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(a.toFixed(2), pad.l - 8, y + 5);
  }
  ctx.textAlign = 'left'; ctx.fillText(formatDay(new Date(t0)), pad.l, H - 8);
  if (t1 !== t0) { ctx.textAlign = 'right'; ctx.fillText(formatDay(new Date(t1)), pad.l + pw, H - 8); }

  // Connect tests of the same position, then draw the marks.
  for (const pos of ['rest', 'postural']) {
    const rs = list.filter((r) => r.position === pos);
    ctx.strokeStyle = cssVar(pos === 'rest' ? '--pen' : '--ink'); ctx.lineWidth = 1.5;
    ctx.beginPath(); rs.forEach((r, i) => (i ? ctx.lineTo(X(r), Y(r.peakAmp)) : ctx.moveTo(X(r), Y(r.peakAmp)))); ctx.stroke();
    for (const r of rs) {
      const x = X(r), y = Y(r.peakAmp);
      if (pos === 'rest') {
        ctx.fillStyle = cssVar('--pen'); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = cssVar('--paper'); ctx.strokeStyle = cssVar('--ink'); ctx.lineWidth = 2;
        ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10);
      }
    }
  }
}

$('#report-name').addEventListener('input', (e) => {
  try { localStorage.setItem(NAME_KEY, e.target.value); } catch { /* storage blocked */ }
});
$('#print-btn').addEventListener('click', () => window.print());
// Charts are sized for the screen; redraw at print size, then back.
window.addEventListener('beforeprint', () => { if (!$('#screen-report').hidden) renderReport(); });
window.addEventListener('afterprint', () => { if (!$('#screen-report').hidden) renderReport(); });

// ---------- Helpers ----------
function formatDay(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatDate(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}
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
window.addEventListener('resize', () => { if (!$('#screen-home').hidden) renderHome(); });

// ---------- Install / offline ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

renderHome();

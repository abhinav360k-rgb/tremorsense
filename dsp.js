// =============================================================
// TremorSense — Digital Signal Processing (DSP) engine
// -------------------------------------------------------------
// Turns raw motion-sensor readings into a frequency spectrum.
//
// Pipeline:
//   1. resample()   phone sensors don't tick at a perfectly steady
//                   rate, so we line the readings up on an even
//                   50-readings-per-second grid.
//   2. highPass()   removes slow drift (gravity, posture shifts)
//                   below 1 Hz, keeping only fast shaking.
//   3. hann window  softens the edges of the 10-second clip so the
//                   FFT doesn't see a fake "jump" at the ends.
//   4. fft()        Fast Fourier Transform: converts "movement over
//                   time" into "how much movement at each frequency".
//
// Important design choice: we analyze each axis (X, Y, Z)
// SEPARATELY and then combine their spectra. Combining the axes
// first with sqrt(X²+Y²+Z²) would "fold" the signal and create a
// fake peak at DOUBLE the real tremor frequency.
// =============================================================

export const TARGET_FS = 50;      // samples per second after resampling
export const BAND_LOW = 3;        // tremor band we search (Hz)
export const BAND_HIGH = 12;
export const MAX_DISPLAY_HZ = 20; // spectrum shown on the chart

// ---- 1. Resample onto an even time grid ----
// Uses Catmull-Rom splines (smooth curves through the points). A plain
// straight-line connect-the-dots would flatten fast tremors (~12% at 12 Hz).
// samples: [{ t: milliseconds, x, y, z }]
export function resample(samples, fs = TARGET_FS) {
  const t0 = samples[0].t;
  const tEnd = samples[samples.length - 1].t;
  const n = Math.floor(((tEnd - t0) / 1000) * fs) + 1;
  const out = { x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
  const last = samples.length - 1;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / fs;
    while (j < last - 1 && samples[j + 1].t < t) j++;
    const p0 = samples[Math.max(j - 1, 0)];
    const p1 = samples[j];
    const p2 = samples[Math.min(j + 1, last)];
    const p3 = samples[Math.min(j + 2, last)];
    const span = p2.t - p1.t || 1;
    const u = Math.min(1, Math.max(0, (t - p1.t) / span));
    for (const k of ['x', 'y', 'z']) out[k][i] = catmullRom(p0[k], p1[k], p2[k], p3[k], u);
  }
  return out;
}

function catmullRom(a, b, c, d, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (3 * b - a - 3 * c + d) * u3);
}

// ---- 2. High-pass filter (2nd-order Butterworth "biquad") ----
// Lets fast motion through, blocks motion slower than `cutoff` Hz.
export function highPass(signal, fs, cutoff = 1) {
  const w0 = (2 * Math.PI * cutoff) / fs;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 0.707 (Butterworth)
  const b0 = (1 + cosw) / 2, b1 = -(1 + cosw), b2 = (1 + cosw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;

  let mean = 0;
  for (const v of signal) mean += v;
  mean /= signal.length;

  const out = new Float64Array(signal.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i] - mean;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

// ---- 3. Hann window ----
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// ---- 4. Fast Fourier Transform (iterative radix-2, in place) ----
// re/im arrays must have a power-of-two length.
export function fft(re, im) {
  const n = re.length;
  // Bit-reversal reordering
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const p = i + k, q = p + half;
        const br = re[q] * cr - im[q] * ci;
        const bi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - br; im[q] = im[p] - bi;
        re[p] += br;        im[p] += bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Amplitude spectrum of one axis, in m/s² (peak amplitude of a sine).
function axisSpectrum(signal, nfft) {
  const n = signal.length;
  const w = hann(n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = signal[i] * w[i];
  fft(re, im);
  const half = nfft / 2;
  const amp = new Float64Array(half);
  // Hann window halves the energy (coherent gain 0.5), so scale by 4/n.
  for (let k = 0; k < half; k++) amp[k] = (4 * Math.hypot(re[k], im[k])) / n;
  return amp;
}

// ---- Full pipeline ----
// samples: [{t, x, y, z}] straight from the sensor
// returns everything the app needs to show and save a result.
export function analyze(samples, { settleSeconds = 1 } = {}) {
  const fs = TARGET_FS;
  const durationRaw = (samples[samples.length - 1].t - samples[0].t) / 1000;
  const rawRate = (samples.length - 1) / durationRaw;

  const grid = resample(samples, fs);
  const skip = Math.round(settleSeconds * fs); // let the filter settle
  const axes = ['x', 'y', 'z'].map((k) => highPass(grid[k], fs, 1).slice(skip));

  const n = axes[0].length;
  const nfft = nextPow2(n) * 4; // zero-padding: finer frequency steps, so peaks between steps aren't under-measured
  const spectra = axes.map((a) => axisSpectrum(a, nfft));
  const binHz = fs / nfft;

  // Combine axes: total shaking amplitude at each frequency.
  const freqs = [];
  const amplitude = [];
  let peakHz = 0, peakAmp = 0, bandPower = 0, totalPower = 0;
  for (let k = 0; k < nfft / 2; k++) {
    const f = k * binHz;
    const a = Math.hypot(spectra[0][k], spectra[1][k], spectra[2][k]);
    if (f >= 1 && f <= MAX_DISPLAY_HZ) totalPower += a * a;
    if (f >= BAND_LOW && f <= BAND_HIGH) {
      bandPower += a * a;
      if (a > peakAmp) { peakAmp = a; peakHz = f; }
    }
    if (f <= MAX_DISPLAY_HZ) { freqs.push(+f.toFixed(3)); amplitude.push(a); }
  }

  return {
    sampleRateHz: Math.round(rawRate),
    analyzedSeconds: +(n / fs).toFixed(1),
    peakHz: +peakHz.toFixed(2),
    peakAmp: +peakAmp.toFixed(4),            // m/s²
    bandRatio: totalPower ? +(bandPower / totalPower).toFixed(3) : 0, // 0–1
    freqs,
    amplitude: amplitude.map((a) => +a.toFixed(5)),
  };
}

// ---- Synthetic signal (demo mode + validation tests) ----
// Fakes a phone recording: a tremor at `freqHz` with `amp` m/s²,
// plus gravity, slow hand drift, random noise and uneven timing.
export function synthesize({ freqHz = 5, amp = 0.3, seconds = 11, rate = 60, noise = 0.02, seed = 1, drift: driftAmp = 0.4 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [];
  let t = 0;
  while (t <= seconds * 1000) {
    const sec = t / 1000;
    const tremor = amp * Math.sin(2 * Math.PI * freqHz * sec);
    const drift = driftAmp * Math.sin(2 * Math.PI * 0.2 * sec);
    out.push({
      t,
      x: tremor * 0.8 + drift + noise * rand() * 2,
      y: tremor * 0.6 + noise * rand() * 2,
      z: 9.81 + tremor * 0.0 + drift * 0.5 + noise * rand() * 2,
    });
    t += 1000 / rate + rand() * 3; // jittery timing like a real phone
  }
  return out;
}

// Validation test: feed fake tremors with KNOWN frequencies through the
// real pipeline and check that TremorSense finds the right answer.
// Run with:  node validate.mjs
import { analyze, synthesize } from './dsp.js';
import { analyzeTaps } from './tapping.js';

const cases = [
  { freqHz: 4, amp: 0.3 },
  { freqHz: 5, amp: 0.5 },
  { freqHz: 6, amp: 0.1 },
  { freqHz: 8, amp: 0.3 },
  { freqHz: 10, amp: 0.2 },
  { freqHz: 12, amp: 0.4 },
  { freqHz: 5, amp: 0.3, rate: 100 }, // faster Android-style sensor
];

let pass = 0;
console.log('Expected Hz | Found Hz | Expected amp | Found amp | Result');
for (const c of cases) {
  const r = analyze(synthesize(c));
  const freqOk = Math.abs(r.peakHz - c.freqHz) <= 0.15;
  const ampOk = Math.abs(r.peakAmp - c.amp) / c.amp <= 0.1;
  const ok = freqOk && ampOk;
  if (ok) pass++;
  console.log(
    `${String(c.freqHz).padEnd(11)} | ${r.peakHz.toFixed(2).padEnd(8)} | ${c.amp.toFixed(2).padEnd(12)} | ${r.peakAmp.toFixed(3).padEnd(9)} | ${ok ? 'PASS' : 'FAIL'}`
  );
}

// A steady hand (only noise + drift) should NOT look like a tremor.
const still = analyze(synthesize({ amp: 0, noise: 0.02 }));
const stillOk = still.peakAmp < 0.05;
if (stillOk) pass++;
console.log(`Steady hand: peak amp ${still.peakAmp.toFixed(3)} m/s² → ${stillOk ? 'PASS' : 'FAIL'}`);

// ---- Tapping test checks ----
console.log('\nTapping checks');
let total = cases.length + 1;
function check(name, ok) { total++; if (ok) pass++; console.log(`${name} → ${ok ? 'PASS' : 'FAIL'}`); }

// Perfectly steady: a valid tap every 200 ms for 15 s = 75 taps, 5.0 taps/s, no slowdown.
const steady = Array.from({ length: 75 }, (_, i) => ({ t: i * 200, valid: true, miss: false }));
const s1 = analyzeTaps(steady);
check(`Steady 200 ms taps: ${s1.rate} taps/s, variation ${s1.cvPct}%, slowdown ${s1.slowdownPct}%`, s1.rate === 5 && s1.cvPct === 0 && Math.abs(s1.slowdownPct) < 1);

// Slowing down: gaps grow from 150 ms to 350 ms, so the last 5 s should have far fewer taps.
const slowing = []; let t = 0;
while (t < 15000) { slowing.push({ t, valid: true, miss: false }); t += 150 + (200 * t) / 15000; }
const s2 = analyzeTaps(slowing);
check(`Slowing taps: slowdown ${s2.slowdownPct}% (should be over 25%)`, s2.slowdownPct > 25);

// Repeats and misses must not count as taps.
const messy = [...steady.slice(0, 10), { t: 2100, valid: false, miss: false }, { t: 2200, valid: false, miss: true }];
const s3 = analyzeTaps(messy);
check(`Repeats and misses ignored: ${s3.taps} taps, ${s3.repeats} repeat, ${s3.misses} miss`, s3.taps === 10 && s3.repeats === 1 && s3.misses === 1);

console.log(`\n${pass}/${total} tests passed`);
process.exit(pass === total ? 0 : 1);

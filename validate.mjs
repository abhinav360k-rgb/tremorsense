// Validation test: feed fake tremors with KNOWN frequencies through the
// real pipeline and check that TremorSense finds the right answer.
// Run with:  node validate.mjs
import { analyze, synthesize } from './dsp.js';

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

console.log(`\n${pass}/${cases.length + 1} tests passed`);
process.exit(pass === cases.length + 1 ? 0 : 1);

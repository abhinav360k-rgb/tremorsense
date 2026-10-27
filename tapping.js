// =============================================================
// TremorSense: finger-tapping test analysis
// -------------------------------------------------------------
// Doctors check for bradykinesia (slowness of movement) by asking
// patients to tap quickly. Three things matter:
//   speed:     how many correct taps per second
//   rhythm:    how evenly spaced the taps are
//   slowdown:  whether taps get slower as the test goes on
//              (called "decrement"; a common sign in Parkinson's)
//
// A tap only counts when it alternates between the two targets,
// so tapping one circle over and over doesn't inflate the score.
// =============================================================

export const TAP_SECONDS = 15;

// taps: [{ t: ms since first tap, valid: true/false, miss: true/false }]
export function analyzeTaps(taps, seconds = TAP_SECONDS) {
  const valid = taps.filter((t) => t.valid);
  const misses = taps.filter((t) => t.miss).length;
  const repeats = taps.filter((t) => !t.valid && !t.miss).length;

  const intervals = [];
  for (let i = 1; i < valid.length; i++) {
    intervals.push({ t: valid[i].t, ms: valid[i].t - valid[i - 1].t });
  }

  const ms = intervals.map((x) => x.ms);
  const mean = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
  const sd = ms.length > 1 ? Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1)) : 0;

  // Compare the first and last thirds (5 s each in a 15 s test).
  const third = (seconds * 1000) / 3;
  const first = valid.filter((t) => t.t < third).length;
  const last = valid.filter((t) => t.t >= 2 * third).length;
  const slowdownPct = first ? ((first - last) / first) * 100 : 0;

  return {
    taps: valid.length,
    rate: +(valid.length / seconds).toFixed(2),          // taps per second
    meanIntervalMs: Math.round(mean),
    cvPct: mean ? +((sd / mean) * 100).toFixed(1) : 0,   // rhythm variation
    slowdownPct: +slowdownPct.toFixed(1),                // + means slower at the end
    misses,
    repeats,
    intervals,
  };
}

// Plain-language summary. Describes the measurement; doesn't diagnose.
export function interpretTaps(r) {
  if (r.taps < 5) {
    return {
      headline: 'Not enough taps to measure',
      detail: 'Fewer than 5 correct taps were counted. Try again, tapping the two circles one after the other.',
    };
  }
  const rhythm = r.cvPct < 15 ? 'steady' : r.cvPct < 30 ? 'a little uneven' : 'uneven';
  let speed;
  if (r.slowdownPct >= 15) speed = `you got slower toward the end, tapping ${Math.round(r.slowdownPct)}% less in the last 5 seconds than the first 5`;
  else if (r.slowdownPct <= -15) speed = 'you sped up toward the end';
  else speed = 'you kept about the same speed the whole time';
  return {
    headline: `${r.rate.toFixed(1)} taps per second`,
    detail: `Your rhythm was ${rhythm}, and ${speed}. Slowing down during the test is one of the things doctors look for, so compare your results over time and share them with your doctor.`,
  };
}

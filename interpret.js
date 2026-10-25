// =============================================================
// ⭐ YOUR FUNCTION — interpretTremor()
// -------------------------------------------------------------
// This is the part of TremorSense you will write and own.
// Right now it's a simple STARTER version so the app works.
// We'll rewrite it together, line by line, and you'll set the
// thresholds using your own validation test results.
//
// Input  (result): numbers from the DSP engine (dsp.js)
//   result.peakHz    strongest shaking frequency, 3–12 Hz
//   result.peakAmp   how strong that shaking is (m/s²)
//   result.bandRatio share of all motion that's in the tremor band (0–1)
// Input  (position): 'rest' or 'postural'
// Output: a plain-language summary for the results screen.
//
// IMPORTANT: TremorSense measures; it does NOT diagnose.
// The wording below must never claim someone has a disease.
// =============================================================

// Provisional numbers — to be tuned from validation testing.
const MIN_AMPLITUDE = 0.05; // m/s²: below this, treat as normal hand steadiness
const MIN_BAND_RATIO = 0.3; // tremor must be a real share of the motion

export function interpretTremor(result, position) {
  const { peakHz, peakAmp, bandRatio } = result;

  if (peakAmp < MIN_AMPLITUDE || bandRatio < MIN_BAND_RATIO) {
    return {
      level: 'none',
      headline: 'No clear tremor',
      detail: 'Your hand moved very little, or it moved without a steady back-and-forth rhythm between 3 and 12 shakes per second.',
    };
  }

  let level = 'mild';
  if (peakAmp >= 0.6) level = 'strong';
  else if (peakAmp >= 0.2) level = 'moderate';

  const range = peakHz < 7 ? 'lower-frequency (3–7 Hz)' : 'higher-frequency (7–12 Hz)';
  const where = position === 'rest' ? 'while your hand was resting' : 'while holding your arm out';

  return {
    level,
    headline: `${capitalize(level)} rhythmic tremor`,
    detail: `Your hand shook in a steady ${range} rhythm ${where}. Bring this result to your doctor, who can tell you what it means.`,
  };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

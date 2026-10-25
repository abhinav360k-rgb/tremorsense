# TremorSense

Measure hand tremor with your phone's motion sensor and bring objective numbers to your doctor.

TremorSense is an installable web app (a Progressive Web App). Open it on a phone, tap **Start tremor test**, and the app records 11 seconds of motion, runs a Fast Fourier Transform (FFT), and reports the strongest shaking frequency and its strength. Results are saved only on the phone, and a one-page **doctor report** (summary, strength-over-time chart and every test) can be printed or saved as a PDF.

**Try the app:** https://abhinav360k-rgb.github.io/tremorsense/ (open on a phone)
**How it works (website):** https://abhinav360k-rgb.github.io/tremorsense/about.html

> TremorSense measures movement. It does **not** diagnose any condition.

## How it works

1. **Record:** the phone's accelerometer reports X, Y and Z motion about 60–100 times per second.
2. **Resample:** readings arrive at uneven times, so they're placed on an even 50-per-second grid using Catmull-Rom spline interpolation.
3. **High-pass filter:** a 2nd-order Butterworth filter removes motion slower than 1 Hz (gravity, posture drift).
4. **Window + FFT:** a Hann window softens the clip edges, then an FFT converts motion over time into motion at each frequency.
5. **Combine axes:** each axis is analyzed separately and the spectra are combined. Combining axes *before* the FFT with √(X²+Y²+Z²) makes the signal always positive, which creates a false peak at double the real tremor frequency (5 Hz reads as 10 Hz, and 8 Hz disappears because 16 Hz is outside the search range).
6. **Interpret:** the strongest peak between 3 and 12 Hz is reported with its amplitude (m/s²).

## Design decisions

- **Chart paper:** doctors have recorded tremors as pen traces on graph paper for decades, so the app is built around one strip of chart paper with a red pen line. It shows your last trace, moves live while recording, and holds the frequency chart.
- **Atkinson Hyperlegible font:** designed by the Braille Institute for people with low vision, which is common among older adults.
- **Big targets, few words:** every button is at least 64px tall, and each screen asks for one thing.
- **No diagnosis language:** results describe the measurement and point to a doctor.
- **Private by default:** no accounts, no server. Results are stored only on the phone.

## Project files

| File | What it does |
|---|---|
| `index.html` | All the app screens |
| `about.html` | Project website: why it exists, a live demo of the math, validation tests, limits |
| `styles.css` | Look and feel: large buttons, high contrast, dark mode |
| `js/dsp.js` | Signal processing: resampling, filter, FFT |
| `js/interpret.js` | Turns the numbers into a plain-language summary (**written by the student**) |
| `js/app.js` | Screens, sensor recording, charts, saving results |
| `sw.js`, `manifest.webmanifest`, `icons/`, `images/` | Make it installable and work offline |
| `tests/validate.mjs` | Validation: known fake tremors must be detected correctly |

## Validation

Run `node tests/validate.mjs`. It feeds simulated tremors at 4, 5, 6, 8, 10 and 12 Hz (with gravity, drift, noise and uneven timing) through the real pipeline. Current results: **8/8 pass**. Frequency is within 0.15 Hz and amplitude within 10% in every case, and a steady hand is correctly reported as no tremor.

## Try it without a phone

Tap **Demo mode** on the home screen. It generates a fake tremor so the app can be demonstrated on a laptop.

## AI use disclosure (Congressional App Challenge)

This log will be completed by the student before submission.

| Part | Who did it |
|---|---|
| Project idea and research | Student, with idea suggestions from Gemini and feedback from Claude |
| App structure, screens, styling, signal-processing code (`dsp.js`, `app.js`), project website (`about.html`) | Generated with Claude (Anthropic), reviewed and tested by student |
| `interpret.js` tremor interpretation logic and thresholds | Student (to be rewritten by student) |
| Validation testing and real-world testing | Student |
| Design decisions, user feedback, video | Student |

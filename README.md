# TremorSense

Measure hand tremor with your phone's motion sensor and bring objective numbers to your doctor.

TremorSense is an installable web app (a Progressive Web App). It has four parts:

- **Tremor test:** the phone records 11 seconds of hand motion, runs a Fast Fourier Transform (FFT), and reports the strongest shaking frequency and its strength, for the resting hand or the arm held out.
- **Tapping test:** the user taps two circles in turn for 15 seconds. The app measures speed, rhythm variation, and slowdown (decrement), a common sign of Parkinson's.
- **Left vs. right:** every test records which hand was used, and the report compares the two sides.
- **Medication log:** one tap logs a dose. The report plots tremor against hours since the last dose to show whether it gets worse as a dose wears off.

Everything is saved only on the phone. The **doctor report** can be printed or saved as a PDF.

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

- **ECG paper and tulip red:** the app is built around a strip of hospital ECG paper (pink grid, black pen trace). It shows your last trace, moves live while recording, and holds every chart. The one strong color is tulip red, because the red tulip is the international symbol of Parkinson's.
- **Features chosen from research on past winners:** earlier Parkinson's apps in the Challenge focused on diagnosis or therapy. TremorSense instead tracks how symptoms change over days and around medication, which a doctor can't see in a short visit.
- **Layout modeled on real health apps:** a bottom tab bar (Today, Tests, Medicine, Report) like StrivePD and Medisafe; a "My day" timeline that puts doses and test results on one chart, like StrivePD's day view; and a daily checklist of short tests, like Apple's mPower Parkinson's study app.
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
| `dsp.js` | Signal processing: resampling, filter, FFT |
| `interpret.js` | Turns the tremor numbers into a plain-language summary (**written by the student**) |
| `tapping.js` | Tapping-test analysis: speed, rhythm variation, slowdown |
| `app.js` | Screens, sensor recording, tapping test, medication log, charts, doctor report, saving results |
| `sw.js`, `manifest.webmanifest`, icon and image files | Make it installable and work offline |
| `validate.mjs` | Validation: known fake tremors must be detected correctly |

## Validation

Run `node validate.mjs`. It feeds simulated tremors at 4, 5, 6, 8, 10 and 12 Hz (with gravity, drift, noise and uneven timing) through the real pipeline: frequency is within 0.15 Hz and amplitude within 10% in every case, and a steady hand is correctly reported as no tremor. It also checks the tapping analysis with steady taps, slowing taps, and taps that shouldn't count. Current results: **11/11 pass**.

## Try it without a phone

Tap **Demo mode** on the home screen. It generates a fake tremor so the app can be demonstrated on a laptop.

## AI use disclosure (Congressional App Challenge)

This log will be completed by the student before submission.

| Part | Who did it |
|---|---|
| Project idea and research | Student, with idea suggestions from Gemini and feedback from Claude |
| App structure, screens, styling, signal-processing code (`dsp.js`), tapping analysis (`tapping.js`), app logic (`app.js`), project website (`about.html`) | Generated with Claude (Anthropic), reviewed and tested by student |
| `interpret.js` tremor interpretation logic and thresholds | Student (to be rewritten by student) |
| Validation testing and real-world testing | Student |
| Design decisions, user feedback, video | Student |

// ===== Configuration =====
const tracks = [
  { id: "kick", name: "Kick", key: "q" },
  { id: "snare", name: "Snare", key: "w" },
  { id: "hihat", name: "Hi-hat", key: "e" },
  { id: "clap", name: "Clap", key: "r" },
];

const stepsPerTrack = 16;

// File paths for sounds (do not change filenames or structure)
const SOUND_FILES = {
  kick: "assets/kick-14.wav",
  snare: "assets/snare-scrubstep.wav",
  hihat: "assets/hat.mp3",
  clap: "assets/clap.wav",
};

// Initial tempo / groove
let bpm = 120;
let swingPercent = 0; // 0–60

// Loop / transport / recording
let isPlaying = false;
let isLoopEnabled = true;
let isRecording = false;
let useSongMode = false;

// Sequencer pattern data: pattern[patternIndex][trackIndex][stepIndex] = stepObject
// stepObject: { active: boolean, velocity: 0–1, probability: 0–1 }
const NUM_PATTERNS = 4;
const patterns = [];
for (let p = 0; p < NUM_PATTERNS; p++) {
  patterns.push(
    tracks.map(() =>
      Array.from({ length: stepsPerTrack }, () => ({
        active: false,
        velocity: 1,
        probability: 1,
      })),
    ),
  );
}

// Current active pattern index
let currentPatternIndex = 0;

// Convenience accessor for current step grid
function getCurrentPatternGrid() {
  return patterns[currentPatternIndex];
}

// Pattern chain for song mode (indexes into patterns or -1 for empty)
const patternChain = [-1, -1, -1, -1];
let currentChainSlot = 0;

// Mute / solo / volume / pan state
const muteState = tracks.map(() => false);
const soloState = tracks.map(() => false);
const volumeState = tracks.map(() => 0.9); // 0.0 - 1.0
const panState = tracks.map(() => 0); // -1 (L) to 1 (R)

// Effects state per track
const effectsState = tracks.map(() => ({
  reverb: true,
  delay: false,
  lp: false,
  hp: false,
  distortion: false,
}));

// Playback state
let currentStepIndex = 0;
let scheduledTimeoutId = null;

// To keep references to step buttons in the grid
// stepButtons[trackIndex][stepIndex] = HTMLElement
const stepButtons = [];

// Piano roll (melody) notes
// notes: { rowIndex (0-7), stepIndex (0-15) }
const pianoRollNotes = [];

// ===== Audio engine (Web Audio API) =====
const AudioEngine = (() => {
  let context = null;
  let masterGain = null;
  const buffers = {}; // soundId -> AudioBuffer

  const trackNodes = tracks.map(() => ({
    gainNode: null,
    panNode: null,
    filterNode: null,
    distortionNode: null,
    delayNode: null,
    delayFeedback: null,
    reverbNode: null,
  }));

  function createContextIfNeeded() {
    if (!context) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return null;
      }
      context = new AudioCtx();

      masterGain = context.createGain();
      masterGain.gain.value = 0.9;
      masterGain.connect(context.destination);

      // Create per-track chains
      tracks.forEach((_, index) => {
        const gainNode = context.createGain();
        gainNode.gain.value = volumeState[index];

        const panNode = context.createStereoPanner();
        panNode.pan.value = panState[index];

        const filterNode = context.createBiquadFilter();
        filterNode.type = "lowpass";
        filterNode.frequency.value = 20000;

        const distortionNode = context.createWaveShaper();
        distortionNode.curve = makeDistortionCurve(0);
        distortionNode.oversample = "4x";

        const delayNode = context.createDelay(1.5);
        delayNode.delayTime.value = 0.0;

        const delayFeedback = context.createGain();
        delayFeedback.gain.value = 0.0;

        const reverbNode = context.createConvolver();
        reverbNode.buffer = buildSimpleImpulse(context);
        // Use simple wet mix by sending some to master and some dry

        // Connect chain: gain -> pan -> filter -> distortion -> delay -> out
        gainNode.connect(panNode);
        panNode.connect(filterNode);
        filterNode.connect(distortionNode);
        distortionNode.connect(delayNode);
        delayNode.connect(masterGain);

        // feedback loop
        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);

        // reverb as parallel send from filterNode
        const reverbSend = context.createGain();
        reverbSend.gain.value = 0.0;
        filterNode.connect(reverbSend);
        reverbSend.connect(reverbNode);
        reverbNode.connect(masterGain);

        trackNodes[index] = {
          gainNode,
          panNode,
          filterNode,
          distortionNode,
          delayNode,
          delayFeedback,
          reverbSend,
          reverbNode,
        };
      });
    }

    // Try to resume if the context is suspended (common autoplay restriction)
    if (context.state === "suspended") {
      context.resume().catch(() => {
        // Ignore resume errors; HTMLAudio fallback will still work
      });
    }

    return context;
  }

  function makeDistortionCurve(amount) {
    const k = typeof amount === "number" ? amount : 0;
    const nSamples = 44100;
    const curve = new Float32Array(nSamples);
    const deg = Math.PI / 180;
    for (let i = 0; i < nSamples; ++i) {
      const x = (i * 2) / nSamples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function buildSimpleImpulse(ctx) {
    const length = ctx.sampleRate * 1.5;
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const channelData = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) {
        channelData[i] =
          (Math.random() * 2 - 1) *
          Math.pow(1 - i / length, 2); // exponential decay
      }
    }
    return impulse;
  }

  async function loadBuffer(soundId) {
    const ctx = createContextIfNeeded();
    if (!ctx) return null;
    if (buffers[soundId]) {
      return buffers[soundId];
    }
    const url = SOUND_FILES[soundId];
    if (!url) return null;
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      buffers[soundId] = audioBuffer;
      return audioBuffer;
    } catch (error) {
      // If fetch/decode fails (e.g. file:// origin), fall back to HTMLAudio
      console.warn("Falling back to HTMLAudio for", soundId, error);
      return null;
    }
  }

  // Preload all drum samples up front for more reliable playback.
  async function preloadDrums() {
    const ids = Object.keys(SOUND_FILES);
    for (const id of ids) {
      try {
        await loadBuffer(id);
      } catch (e) {
        console.warn("Error preloading sample", id, e);
      }
    }
  }

  async function triggerSound(soundId, trackIndex, velocity = 1) {
    const ctx = createContextIfNeeded();
    // If Web Audio is unavailable, or buffer loading fails, fall back to HTMLAudio.
    const buffer = ctx ? await loadBuffer(soundId) : null;
    if (!ctx || !buffer) {
      const file = SOUND_FILES[soundId];
      if (!file) return;
      const htmlAudio = new Audio(file);
      htmlAudio.volume = (volumeState[trackIndex] || 1) * velocity;
      htmlAudio.currentTime = 0;
      htmlAudio.play().catch(() => {});
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const trackNode = trackNodes[trackIndex];
    if (!trackNode || !trackNode.gainNode) return;

    // Apply velocity as gain multiplier
    const velGain = ctx.createGain();
    velGain.gain.value = Math.max(0, Math.min(1, velocity));

    source.connect(velGain);
    velGain.connect(trackNode.gainNode);

    source.start();
  }

  function updateTrackVolume(trackIndex, value) {
    const ctx = createContextIfNeeded();
    if (!ctx) return;
    const node = trackNodes[trackIndex];
    if (node && node.gainNode) {
      node.gainNode.gain.value = value;
    }
  }

  function updateTrackPan(trackIndex, panValue) {
    const ctx = createContextIfNeeded();
    if (!ctx) return;
    const node = trackNodes[trackIndex];
    if (node && node.panNode) {
      node.panNode.pan.value = panValue;
    }
  }

  function updateTrackEffects(trackIndex) {
    const ctx = createContextIfNeeded();
    if (!ctx) return;
    const node = trackNodes[trackIndex];
    if (!node) return;
    const fx = effectsState[trackIndex];

    // Reverb send
    node.reverbSend.gain.value = fx.reverb ? 0.3 : 0.0;

    // Delay: short slapback when enabled
    node.delayNode.delayTime.value = fx.delay ? 0.22 : 0.0;
    node.delayFeedback.gain.value = fx.delay ? 0.25 : 0.0;

    // Filter modes
    if (fx.lp) {
      node.filterNode.type = "lowpass";
      node.filterNode.frequency.value = 4000;
    } else if (fx.hp) {
      node.filterNode.type = "highpass";
      node.filterNode.frequency.value = 600;
    } else {
      node.filterNode.type = "lowpass";
      node.filterNode.frequency.value = 20000;
    }

    // Distortion amount
    const amount = fx.distortion ? 50 : 0;
    node.distortionNode.curve = makeDistortionCurve(amount);
  }

  function triggerMelodyOsc(pitchRow, stepDurationMs) {
    const ctx = createContextIfNeeded();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Map row (0 bottom, 7 top) to a simple scale
    const baseFreq = 220; // A3
    const semitone = Math.pow(2, 1 / 12);
    const semitoneOffset = pitchRow * 2; // every row a whole step
    const freq = baseFreq * Math.pow(semitone, semitoneOffset);

    osc.type = "square";
    osc.frequency.value = freq;

    gain.gain.value = 0.3;

    osc.connect(gain);
    gain.connect(masterGain || ctx.destination);

    const now = ctx.currentTime;
    const durationSec = stepDurationMs / 1000;

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    osc.start(now);
    osc.stop(now + durationSec + 0.05);
  }

  return {
    triggerSound,
    updateTrackVolume,
    updateTrackPan,
    updateTrackEffects,
    triggerMelodyOsc,
    ensureContext: createContextIfNeeded,
    preloadDrums,
  };
})();

// ===== Utility: time between steps based on BPM =====
function getStepIntervalMs(currentBpm) {
  // One step is a 16th note
  // 60 / BPM = seconds per beat (quarter note)
  // divide by 4 for sixteenth notes
  const secondsPerBeat = 60 / currentBpm;
  const secondsPerStep = secondsPerBeat / 4;
  return secondsPerStep * 1000;
}

// ===== Audio playback wrapper =====
function playSound(soundId, trackIndex, velocity = 1) {
  const file = SOUND_FILES[soundId];
  if (!file) return;

  // Respect mute / solo
  if (!isTrackAudible(trackIndex)) return;

  AudioEngine.triggerSound(soundId, trackIndex, velocity).catch(() => {});
}

// Track is audible if:
// - At least one solo: only soloed tracks are audible
// - Otherwise: all tracks except muted ones
function isTrackAudible(trackIndex) {
  const anySolo = soloState.some((v) => v);
  if (anySolo) {
    return soloState[trackIndex];
  }
  return !muteState[trackIndex];
}

// ===== Sequencer grid creation =====
function createSequencerGrid() {
  const grid = document.getElementById("sequencer-grid");

  tracks.forEach((track, trackIndex) => {
    const row = document.createElement("div");
    row.classList.add("track-row");

    // --- Left: track info (name, mute/solo, volume, pan) ---
    const info = document.createElement("div");
    info.classList.add("track-info");

    const headerLine = document.createElement("div");
    headerLine.classList.add("track-header-line");

    const nameSpan = document.createElement("span");
    nameSpan.classList.add("track-name");
    nameSpan.textContent = track.name;

    const controls = document.createElement("div");
    controls.classList.add("track-controls");

    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.classList.add("mute-btn");
    muteBtn.textContent = "M";
    muteBtn.title = "Mute " + track.name;
    muteBtn.dataset.trackIndex = trackIndex;

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.classList.add("solo-btn");
    soloBtn.textContent = "S";
    soloBtn.title = "Solo " + track.name;
    soloBtn.dataset.trackIndex = trackIndex;

    controls.appendChild(muteBtn);
    controls.appendChild(soloBtn);

    headerLine.appendChild(nameSpan);
    headerLine.appendChild(controls);

    const volumeWrapper = document.createElement("div");
    const volumeSlider = document.createElement("input");
    volumeSlider.type = "range";
    volumeSlider.min = "0";
    volumeSlider.max = "100";
    volumeSlider.value = String(volumeState[trackIndex] * 100);
    volumeSlider.classList.add("volume-slider");
    volumeSlider.dataset.trackIndex = trackIndex;

    const panSlider = document.createElement("input");
    panSlider.type = "range";
    panSlider.min = "-100";
    panSlider.max = "100";
    panSlider.value = String(panState[trackIndex] * 100);
    panSlider.classList.add("volume-slider", "pan-knob");
    panSlider.dataset.trackIndex = trackIndex;
    panSlider.title = "Pan (L/R)";

    volumeWrapper.appendChild(volumeSlider);
    volumeWrapper.appendChild(panSlider);

    info.appendChild(headerLine);
    info.appendChild(volumeWrapper);

    // --- Right: steps row ---
    const stepsRow = document.createElement("div");
    stepsRow.classList.add("steps-row");

    const rowButtons = [];

    for (let stepIndex = 0; stepIndex < stepsPerTrack; stepIndex++) {
      const stepButton = document.createElement("button");
      stepButton.type = "button";
      stepButton.classList.add("step");
      stepButton.dataset.trackIndex = trackIndex;
      stepButton.dataset.stepIndex = stepIndex;

      stepButton.addEventListener("click", (event) => {
        toggleStep(trackIndex, stepIndex, event);
      });

      stepsRow.appendChild(stepButton);
      rowButtons.push(stepButton);
    }

    stepButtons.push(rowButtons);

    row.appendChild(info);
    row.appendChild(stepsRow);
    grid.appendChild(row);

    // Mute button events
    muteBtn.addEventListener("click", () => {
      muteState[trackIndex] = !muteState[trackIndex];
      muteBtn.classList.toggle("is-active", muteState[trackIndex]);
    });

    // Solo button events
    soloBtn.addEventListener("click", () => {
      soloState[trackIndex] = !soloState[trackIndex];
      soloBtn.classList.toggle("is-active", soloState[trackIndex]);
    });

    // Volume slider events
    volumeSlider.addEventListener("input", (event) => {
      const value = Number(event.target.value) || 0;
      const vol = value / 100;
      volumeState[trackIndex] = vol;
      AudioEngine.updateTrackVolume(trackIndex, vol);
    });

    panSlider.addEventListener("input", (event) => {
      const value = Number(event.target.value) || 0;
      const pan = value / 100; // -1 to 1
      panState[trackIndex] = pan;
      AudioEngine.updateTrackPan(trackIndex, pan);
    });
  });
}

// ===== Mixer UI rendering =====
function createMixerUI() {
  const container = document.getElementById("mixer-strips");
  container.innerHTML = "";

  tracks.forEach((track, trackIndex) => {
    const strip = document.createElement("div");
    strip.classList.add("mixer-strip");

    const title = document.createElement("div");
    title.classList.add("mixer-strip-title");
    title.textContent = track.name;
    strip.appendChild(title);

    const fader = document.createElement("input");
    fader.type = "range";
    fader.min = "0";
    fader.max = "100";
    fader.value = String(volumeState[trackIndex] * 100);
    fader.classList.add("mixer-fader");
    strip.appendChild(fader);

    const pan = document.createElement("input");
    pan.type = "range";
    pan.min = "-100";
    pan.max = "100";
    pan.value = String(panState[trackIndex] * 100);
    pan.classList.add("mixer-pan");
    strip.appendChild(pan);

    const btnRow = document.createElement("div");
    btnRow.classList.add("mixer-buttons");

    const muteBtn = document.createElement("button");
    muteBtn.textContent = "M";
    muteBtn.classList.add("mute-btn");
    if (muteState[trackIndex]) muteBtn.classList.add("is-active");

    const soloBtn = document.createElement("button");
    soloBtn.textContent = "S";
    soloBtn.classList.add("solo-btn");
    if (soloState[trackIndex]) soloBtn.classList.add("is-active");

    btnRow.appendChild(muteBtn);
    btnRow.appendChild(soloBtn);
    strip.appendChild(btnRow);

    const fxFlags = document.createElement("div");
    fxFlags.classList.add("mixer-effect-flags");

    const fxNames = ["reverb", "delay", "lp", "hp", "distortion"];
    fxNames.forEach((name) => {
      const fxBtn = document.createElement("button");
      fxBtn.textContent = name.toUpperCase();
      fxBtn.classList.add("mixer-effect-toggle");
      if (effectsState[trackIndex][name]) fxBtn.classList.add("is-on");
      fxBtn.dataset.fxName = name;
      fxBtn.addEventListener("click", () => {
        effectsState[trackIndex][name] = !effectsState[trackIndex][name];
        fxBtn.classList.toggle("is-on", effectsState[trackIndex][name]);
        AudioEngine.updateTrackEffects(trackIndex);
      });
      fxFlags.appendChild(fxBtn);
    });

    strip.appendChild(fxFlags);
    container.appendChild(strip);

    // Hook events
    fader.addEventListener("input", (event) => {
      const value = Number(event.target.value) || 0;
      const vol = value / 100;
      volumeState[trackIndex] = vol;
      AudioEngine.updateTrackVolume(trackIndex, vol);
    });

    pan.addEventListener("input", (event) => {
      const value = Number(event.target.value) || 0;
      const panVal = value / 100;
      panState[trackIndex] = panVal;
      AudioEngine.updateTrackPan(trackIndex, panVal);
    });

    muteBtn.addEventListener("click", () => {
      muteState[trackIndex] = !muteState[trackIndex];
      muteBtn.classList.toggle("is-active", muteState[trackIndex]);
    });

    soloBtn.addEventListener("click", () => {
      soloState[trackIndex] = !soloState[trackIndex];
      soloBtn.classList.toggle("is-active", soloState[trackIndex]);
    });
  });
}

// ===== Pattern and step visuals =====
function getStepObject(trackIndex, stepIndex) {
  const grid = getCurrentPatternGrid();
  return grid[trackIndex][stepIndex];
}

function toggleStep(trackIndex, stepIndex, event) {
  const step = getStepObject(trackIndex, stepIndex);
  const isAlt = event && event.altKey;
  const isShift = event && event.shiftKey;

  if (!step.active) {
    step.active = true;
    step.velocity = isShift ? 1 : 0.9;
    step.probability = 1;
  } else if (isAlt) {
    // Cycle probability downward
    if (step.probability > 0.75) {
      step.probability = 0.75;
    } else if (step.probability > 0.5) {
      step.probability = 0.5;
    } else if (step.probability > 0.25) {
      step.probability = 0.25;
    } else {
      step.active = false;
      step.probability = 1;
    }
  } else if (isShift) {
    // Cycle velocity
    if (step.velocity < 0.6) {
      step.velocity = 0.9;
    } else {
      step.velocity = 0.5;
    }
  } else {
    // Normal click toggles on/off
    step.active = !step.active;
    if (!step.active) {
      step.velocity = 1;
      step.probability = 1;
    }
  }

  updateStepVisual(trackIndex, stepIndex);
}

function updateStepVisual(trackIndex, stepIndex) {
  const step = getStepObject(trackIndex, stepIndex);
  const button = stepButtons[trackIndex][stepIndex];

  button.classList.toggle("is-active", step.active);

  // Velocity hint
  button.classList.toggle("low-velocity", step.velocity < 0.8);

  // Probability hints
  button.classList.remove("prob-low", "prob-medium", "prob-very-low");
  if (step.active) {
    if (step.probability < 0.3) {
      button.classList.add("prob-very-low");
    } else if (step.probability < 0.6) {
      button.classList.add("prob-medium");
    } else if (step.probability < 1) {
      button.classList.add("prob-low");
    }
  }
}

function refreshWholePatternVisual() {
  const grid = getCurrentPatternGrid();
  for (let t = 0; t < tracks.length; t++) {
    for (let s = 0; s < stepsPerTrack; s++) {
      const step = grid[t][s];
      const btn = stepButtons[t][s];
      btn.classList.toggle("is-active", step.active);
      btn.classList.toggle("is-current", s === currentStepIndex);
      btn.classList.toggle("low-velocity", step.velocity < 0.8);
      btn.classList.remove("prob-low", "prob-medium", "prob-very-low");
      if (step.active) {
        if (step.probability < 0.3) {
          btn.classList.add("prob-very-low");
        } else if (step.probability < 0.6) {
          btn.classList.add("prob-medium");
        } else if (step.probability < 1) {
          btn.classList.add("prob-low");
        }
      }
    }
  }
}

function clearPattern() {
  const grid = getCurrentPatternGrid();
  for (let t = 0; t < tracks.length; t++) {
    for (let s = 0; s < stepsPerTrack; s++) {
      const step = grid[t][s];
      step.active = false;
      step.velocity = 1;
      step.probability = 1;
      stepButtons[t][s].classList.remove(
        "is-active",
        "is-current",
        "low-velocity",
        "prob-low",
        "prob-medium",
        "prob-very-low",
      );
    }
  }
}

function randomizePattern() {
  // Different "density" per track to sound musical
  const densityByTrack = [0.45, 0.3, 0.65, 0.2]; // kick, snare, hihat, clap
  const grid = getCurrentPatternGrid();

  for (let t = 0; t < tracks.length; t++) {
    const density = densityByTrack[t];
    for (let s = 0; s < stepsPerTrack; s++) {
      const active = Math.random() < density;
      const step = grid[t][s];
      step.active = active;
      step.velocity = active ? 0.8 + Math.random() * 0.2 : 1;
      step.probability = active ? 0.8 + Math.random() * 0.2 : 1;
      updateStepVisual(t, s);
    }
  }
}

// Highlight the current column for playhead animation
function clearCurrentStepHighlight() {
  stepButtons.forEach((row) => {
    row.forEach((btn) => btn.classList.remove("is-current"));
  });
}

function highlightCurrentStep(stepIndex) {
  stepButtons.forEach((row) => {
    const btn = row[stepIndex];
    if (btn) {
      btn.classList.add("is-current");
    }
  });
  updateTimelinePlayhead(stepIndex);
}

// ===== Timeline / pattern chain rendering =====
function buildTimelineRuler() {
  const ruler = document.getElementById("timeline-ruler");
  ruler.innerHTML = "";
  for (let i = 0; i < stepsPerTrack; i++) {
    const cell = document.createElement("div");
    cell.classList.add("timeline-ruler-cell");
    const bar = Math.floor(i / 4) + 1;
    const beatInBar = (i % 4) + 1;
    cell.textContent = `${bar}.${beatInBar}`;
    ruler.appendChild(cell);
  }
}

function buildTimelinePatternRow() {
  const row = document.getElementById("timeline-pattern-row");
  row.innerHTML = "";
  for (let i = 0; i < stepsPerTrack; i++) {
    const cell = document.createElement("div");
    cell.classList.add("timeline-pattern-cell");
    row.appendChild(cell);
  }
  refreshTimelinePatternRow();
}

function refreshTimelinePatternRow() {
  const row = document.getElementById("timeline-pattern-row");
  if (!row) return;

  const cells = Array.from(row.children);
  cells.forEach((cell, index) => {
    const chainIndex = Math.floor((index / stepsPerTrack) * patternChain.length);
    const patternIndex = patternChain[chainIndex] ?? -1;
    const hasPattern = patternIndex >= 0;
    cell.classList.toggle("has-pattern", hasPattern);
  });
}

function updateTimelinePlayhead(stepIndex) {
  const playhead = document.getElementById("timeline-playhead");
  if (!playhead) return;

  const fraction = stepIndex / stepsPerTrack;
  playhead.style.transform = `translateX(${fraction * 100}%)`;
}

// ===== Piano roll rendering & logic =====
const PIANO_PITCH_LABELS = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"];

function buildPianoRoll() {
  const keysContainer = document.getElementById("piano-roll-keys");
  const gridContainer = document.getElementById("piano-roll-grid");

  keysContainer.innerHTML = "";
  gridContainer.innerHTML = "";

  for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
    const key = document.createElement("div");
    key.classList.add("piano-roll-key");
    key.textContent = PIANO_PITCH_LABELS[7 - rowIndex]; // top = C5
    keysContainer.appendChild(key);

    const row = document.createElement("div");
    row.classList.add("piano-roll-row");
    for (let stepIndex = 0; stepIndex < stepsPerTrack; stepIndex++) {
      const cell = document.createElement("div");
      cell.classList.add("piano-roll-cell");
      cell.dataset.rowIndex = rowIndex.toString();
      cell.dataset.stepIndex = stepIndex.toString();

      cell.addEventListener("click", () => {
        togglePianoNote(rowIndex, stepIndex);
      });

      row.appendChild(cell);
    }
    gridContainer.appendChild(row);
  }

  refreshPianoRollVisual();
}

function togglePianoNote(rowIndex, stepIndex) {
  const existingIndex = pianoRollNotes.findIndex(
    (n) => n.rowIndex === rowIndex && n.stepIndex === stepIndex,
  );

  if (existingIndex !== -1) {
    pianoRollNotes.splice(existingIndex, 1);
  } else {
    pianoRollNotes.push({ rowIndex, stepIndex });
  }
  refreshPianoRollVisual();
}

function refreshPianoRollVisual() {
  const gridContainer = document.getElementById("piano-roll-grid");
  if (!gridContainer) return;

  const rows = Array.from(gridContainer.children);
  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.children);
    cells.forEach((cell, stepIndex) => {
      const has = pianoRollNotes.some(
        (n) => n.rowIndex === rowIndex && n.stepIndex === stepIndex,
      );
      cell.classList.toggle("has-note", has);
    });
  });
}

function playPianoRollForStep(stepIndex) {
  const stepDurationMs = getStepIntervalMs(bpm);
  pianoRollNotes.forEach((note) => {
    if (note.stepIndex === stepIndex) {
      // Map PC row index to pitch: our rows are 0 bottom -> 7 top (we built reversed labels)
      const pitchRow = 7 - note.rowIndex;
      AudioEngine.triggerMelodyOsc(pitchRow, stepDurationMs);
    }
  });
}

// ===== Playback logic =====
function playCurrentStep(stepIndex) {
  const grid = getCurrentPatternGrid();
  tracks.forEach((track, trackIndex) => {
    const step = grid[trackIndex][stepIndex];
    if (!step.active) return;
    if (Math.random() > step.probability) return;

    playSound(track.id, trackIndex, step.velocity);
  });

  // Melody / piano roll
  playPianoRollForStep(stepIndex);
}

function stepTick() {
  clearCurrentStepHighlight();
  highlightCurrentStep(currentStepIndex);
  playCurrentStep(currentStepIndex);

  currentStepIndex = (currentStepIndex + 1) % stepsPerTrack;

  // Handle song mode pattern chaining
  if (currentStepIndex === 0 && useSongMode) {
    advancePatternChain();
  }
}

function computeSwingScaledInterval() {
  const base = getStepIntervalMs(bpm);
  const swing = swingPercent / 100;
  if (swing <= 0) return base;
  const isOffbeat = currentStepIndex % 2 === 1;
  const swingAmount = base * swing * 0.5;
  return isOffbeat ? base + swingAmount : base - swingAmount;
}

function scheduleNextStep() {
  if (!isPlaying) return;
  stepTick();
  const delay = computeSwingScaledInterval();
  scheduledTimeoutId = window.setTimeout(scheduleNextStep, delay);
}

function startPlayback() {
  if (isPlaying) return;

  isPlaying = true;

  const playBtn = document.getElementById("play-button");
  const pauseBtn = document.getElementById("pause-button");
  const stopBtn = document.getElementById("stop-button");

  // resume audio context on user gesture
  AudioEngine.ensureContext();
  // Preload drum samples once playback is initiated
  AudioEngine.preloadDrums().catch(() => {});

  playBtn.disabled = true;
  pauseBtn.disabled = false;
  stopBtn.disabled = false;

  scheduleNextStep();
}

function pausePlayback() {
  if (!isPlaying) return;

  isPlaying = false;

  const playBtn = document.getElementById("play-button");
  const pauseBtn = document.getElementById("pause-button");

  playBtn.disabled = false;
  pauseBtn.disabled = true;

  if (scheduledTimeoutId !== null) {
    window.clearTimeout(scheduledTimeoutId);
    scheduledTimeoutId = null;
  }
  // Do not clear currentStepIndex or highlight (so resume feels natural)
}

function stopPlayback() {
  if (!isPlaying && scheduledTimeoutId === null) {
    // Already stopped
    return;
  }

  isPlaying = false;

  const playBtn = document.getElementById("play-button");
  const pauseBtn = document.getElementById("pause-button");
  const stopBtn = document.getElementById("stop-button");

  playBtn.disabled = false;
  pauseBtn.disabled = true;
  stopBtn.disabled = true;

  if (scheduledTimeoutId !== null) {
    window.clearTimeout(scheduledTimeoutId);
    scheduledTimeoutId = null;
  }

  currentStepIndex = 0;
  clearCurrentStepHighlight();
  updateTimelinePlayhead(0);
}

// When BPM changes, new schedule uses updated BPM automatically
function handleBpmChange(newBpm) {
  bpm = newBpm;
  const bpmValueSpan = document.getElementById("bpm-value");
  bpmValueSpan.textContent = String(Math.round(bpm));
}

function handleSwingChange(newSwing) {
  swingPercent = newSwing;
  const swingValueSpan = document.getElementById("swing-value");
  swingValueSpan.textContent = String(Math.round(swingPercent));
}

// ===== Pattern system =====
function saveCurrentPatternToIndex(index) {
  if (index < 0 || index >= NUM_PATTERNS) return;
  const sourceGrid = getCurrentPatternGrid();
  const destGrid = patterns[index];

  for (let t = 0; t < tracks.length; t++) {
    for (let s = 0; s < stepsPerTrack; s++) {
      const sSrc = sourceGrid[t][s];
      destGrid[t][s].active = sSrc.active;
      destGrid[t][s].velocity = sSrc.velocity;
      destGrid[t][s].probability = sSrc.probability;
    }
  }
}

function switchToPattern(index) {
  if (index < 0 || index >= NUM_PATTERNS) return;
  currentPatternIndex = index;
  refreshWholePatternVisual();
}

function duplicatePattern(sourceIndex, targetIndex) {
  if (
    sourceIndex < 0 ||
    sourceIndex >= NUM_PATTERNS ||
    targetIndex < 0 ||
    targetIndex >= NUM_PATTERNS
  ) {
    return;
  }
  const srcGrid = patterns[sourceIndex];
  const destGrid = patterns[targetIndex];
  for (let t = 0; t < tracks.length; t++) {
    for (let s = 0; s < stepsPerTrack; s++) {
      const src = srcGrid[t][s];
      destGrid[t][s].active = src.active;
      destGrid[t][s].velocity = src.velocity;
      destGrid[t][s].probability = src.probability;
    }
  }
}

function advancePatternChain() {
  if (!useSongMode) return;

  const validSlots = patternChain
    .map((p, i) => ({ pattern: p, slot: i }))
    .filter((s) => s.pattern >= 0);
  if (validSlots.length === 0) return;

  // Find next slot
  let nextSlot = currentChainSlot;
  let attempts = 0;
  do {
    nextSlot = (nextSlot + 1) % patternChain.length;
    attempts++;
    if (patternChain[nextSlot] >= 0) break;
  } while (attempts < patternChain.length + 1);

  currentChainSlot = nextSlot;
  const nextPattern = patternChain[currentChainSlot];
  if (nextPattern >= 0) {
    currentPatternIndex = nextPattern;
    const patternSelect = document.getElementById("pattern-select");
    if (patternSelect) {
      patternSelect.value = String(currentPatternIndex);
    }
    refreshWholePatternVisual();
  }
}

// ===== Drum pads & keyboard shortcuts / recording =====
function setupPads() {
  const pads = document.querySelectorAll(".pad");

  pads.forEach((pad) => {
    const soundId = pad.dataset.sound;
    const key = pad.dataset.key;

    pad.addEventListener("click", () => {
      const trackIndex = tracks.findIndex((t) => t.id === soundId);
      if (trackIndex !== -1) {
        const velocity = 1;
        playSound(soundId, trackIndex, velocity);
        if (isRecording && isPlaying) {
          recordHitToSequencer(trackIndex, velocity);
        }
      }
      triggerPadAnimation(pad);
    });

    // Save mapping for keyboard
    pad.dataset.keyLower = key.toLowerCase();
  });

  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const key = event.key.toLowerCase();
    const matchingPad = Array.from(pads).find(
      (pad) => pad.dataset.keyLower === key,
    );
    if (!matchingPad) return;

    const soundId = matchingPad.dataset.sound;
    const trackIndex = tracks.findIndex((t) => t.id === soundId);
    if (trackIndex !== -1) {
      // Modifiers give rough "velocity"
      let velocity = 0.9;
      if (event.shiftKey) velocity = 1;
      if (event.altKey) velocity = 0.6;

      playSound(soundId, trackIndex, velocity);
      if (isRecording && isPlaying) {
        recordHitToSequencer(trackIndex, velocity);
      }
    }
    triggerPadAnimation(matchingPad);
  });
}

function recordHitToSequencer(trackIndex, velocity) {
  const grid = getCurrentPatternGrid();
  const step = grid[trackIndex][currentStepIndex];
  step.active = true;
  step.velocity = velocity;
  step.probability = 1;
  updateStepVisual(trackIndex, currentStepIndex);
}

function triggerPadAnimation(padElement) {
  padElement.classList.add("is-active");
  setTimeout(() => {
    padElement.classList.remove("is-active");
  }, 110);
}

// ===== Transport and global controls UI =====
function setupTransportAndControls() {
  const playBtn = document.getElementById("play-button");
  const pauseBtn = document.getElementById("pause-button");
  const stopBtn = document.getElementById("stop-button");
  const clearBtn = document.getElementById("clear-button");
  const randomBtn = document.getElementById("random-button");
  const bpmSlider = document.getElementById("bpm-slider");
  const swingSlider = document.getElementById("swing-slider");
  const loopToggle = document.getElementById("loop-toggle");
  const recordToggle = document.getElementById("record-toggle");
  const patternSelect = document.getElementById("pattern-select");
  const patternSave = document.getElementById("pattern-save");
  const patternDuplicate = document.getElementById("pattern-duplicate");
  const songModeToggle = document.getElementById("song-mode-toggle");
  const chainSelects = document.querySelectorAll(".pattern-chain-slot");

  // Initial transport state
  pauseBtn.disabled = true;
  stopBtn.disabled = true;

  playBtn.addEventListener("click", startPlayback);
  pauseBtn.addEventListener("click", pausePlayback);
  stopBtn.addEventListener("click", stopPlayback);

  clearBtn.addEventListener("click", () => {
    clearPattern();
  });

  randomBtn.addEventListener("click", () => {
    randomizePattern();
  });

  // Tempo slider
  bpmSlider.addEventListener("input", (event) => {
    const newBpm = Number(event.target.value) || 120;
    handleBpmChange(newBpm);
  });

  swingSlider.addEventListener("input", (event) => {
    const newSwing = Number(event.target.value) || 0;
    handleSwingChange(newSwing);
  });

  // Loop toggle
  loopToggle.addEventListener("click", () => {
    isLoopEnabled = !isLoopEnabled;
    loopToggle.classList.toggle("btn-toggle-active", isLoopEnabled);
  });

  // Record toggle
  recordToggle.addEventListener("click", () => {
    isRecording = !isRecording;
    recordToggle.classList.toggle("btn-toggle-active", isRecording);
  });

  // Pattern select/save/duplicate
  patternSelect.addEventListener("change", (event) => {
    const index = Number(event.target.value) || 0;
    switchToPattern(index);
  });

  patternSave.addEventListener("click", () => {
    saveCurrentPatternToIndex(currentPatternIndex);
  });

  patternDuplicate.addEventListener("click", () => {
    // Duplicate current pattern into the next one (if exists)
    const targetIndex =
      (currentPatternIndex + 1) % NUM_PATTERNS === currentPatternIndex
        ? currentPatternIndex
        : (currentPatternIndex + 1) % NUM_PATTERNS;
    duplicatePattern(currentPatternIndex, targetIndex);
  });

  // Song mode
  songModeToggle.addEventListener("click", () => {
    useSongMode = !useSongMode;
    songModeToggle.classList.toggle("btn-toggle-active", useSongMode);
  });

  chainSelects.forEach((select) => {
    select.addEventListener("change", (event) => {
      const slot = Number(event.target.dataset.slot) || 0;
      const value = Number(event.target.value);
      patternChain[slot] = value >= 0 ? value : -1;
      refreshTimelinePatternRow();
    });
  });

  // Show starting BPM & swing
  document.getElementById("bpm-value").textContent = String(bpm);
  document.getElementById("swing-value").textContent =
    String(Math.round(swingPercent));
}

// ===== Initialization =====
document.addEventListener("DOMContentLoaded", () => {
  // Build sequencer UI
  createSequencerGrid();

  // Setup pads + keyboard
  setupPads();

  // Mixer, timeline, piano roll
  createMixerUI();
  buildTimelineRuler();
  buildTimelinePatternRow();
  buildPianoRoll();

  // Setup transport / pattern / global controls
  setupTransportAndControls();
});
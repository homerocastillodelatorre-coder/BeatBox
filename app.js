// ===== Configuration =====
// Google Sheets storage via Google Apps Script Web App API
// Paste your deployed Apps Script Web App URL here.
const API_URL = "PASTE_MY_GOOGLE_APPS_SCRIPT_URL_HERE";

function saveBeatToSheet(beatData) {
  return fetch(API_URL, {
    method: "POST",
    body: JSON.stringify(beatData),
  });
}

// ===== Firebase Cloud Storage (ADDED — does not replace local storage) =====
// Replace the placeholder values below with your Firebase project config.
// Get these from: Firebase Console → Project Settings → Your apps → Web app → SDK setup
const firebaseConfig = {
  apiKey:            "AIzaSyAnnUyJgyuA7lLL1qrBCmcdscqokVZ3hi8",
  authDomain:        "beatbox-75519.firebaseapp.com",
  projectId:         "beatbox-75519",
  storageBucket:     "beatbox-75519.firebasestorage.app",
  messagingSenderId: "29792924165",
  appId:             "1:29792924165:web:e68ec3fcd839dc3653226c",
};

// Initialize Firebase (only once; guard against accidental double-init).
let db = null;
(function initFirebase() {
  try {
    if (typeof firebase === "undefined") {
      console.warn("[Firebase] SDK not loaded — cloud save/load disabled.");
      return;
    }
    // Avoid re-initializing if already done (e.g. hot-reload scenarios).
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    console.log("[Firebase] Initialized successfully.");
  } catch (err) {
    console.error("[Firebase] Initialization failed:", err);
  }
})();

/**
 * saveBeatToFirebase – saves a beat object to the "beats" Firestore collection.
 * Returns a Promise that resolves with the new document reference.
 * Safe to call even if Firebase is not configured (logs a warning and resolves silently).
 *
 * @param {Object} beatData  – Any serialisable beat object (name, bpm, pattern, etc.)
 * @returns {Promise<firebase.firestore.DocumentReference|null>}
 */
function saveBeatToFirebase(beatData) {
  if (!db) {
    console.warn("[Firebase] saveBeatToFirebase called but Firestore not ready. Skipping.");
    return Promise.resolve(null);
  }
  return db.collection("beats")
    .add({ ...beatData, createdAt: Date.now() })
    .then((docRef) => {
      console.log("[Firebase] Beat saved to cloud. Doc ID:", docRef.id);
      return docRef;
    })
    .catch((err) => {
      console.error("[Firebase] Error saving beat to cloud:", err);
      return null;
    });
}

/**
 * loadBeatsFromFirebase – fetches all beats from the "beats" Firestore collection.
 * Returns a Promise that resolves with an array of beat objects (with id fields).
 * Safe to call even if Firebase is not configured (resolves with empty array).
 *
 * @returns {Promise<Array<Object>>}
 */
async function loadBeatsFromFirebase() {
  if (!db) {
    console.warn("[Firebase] loadBeatsFromFirebase called but Firestore not ready. Returning [].");
    return [];
  }
  try {
    const snapshot = await db.collection("beats").orderBy("createdAt", "desc").get();
    const beats = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    console.log(`[Firebase] Loaded ${beats.length} beat(s) from cloud.`);
    return beats;
  } catch (err) {
    console.error("[Firebase] Error loading beats from cloud:", err);
    return [];
  }
}

// Expose Firebase helpers for sidebar.js
window.saveBeatToFirebase  = saveBeatToFirebase;
window.loadBeatsFromFirebase = loadBeatsFromFirebase;
// ===== End Firebase Cloud Storage =====

let tracks = [
  { id: "kick", name: "Kick", key: "q" },
  { id: "snare", name: "Snare", key: "w" },
  { id: "hihat", name: "Hi-hat", key: "e" },
  { id: "clap", name: "Clap", key: "r" },
];

const ALLOWED_STEP_COUNTS = [16, 20, 24, 32];

let stepsPerTrack = 20;

// File paths for sounds (do not change filenames or structure)
const SOUND_FILES = {
  kick: "assets/kick-14.wav",
  snare: "assets/snare-scrubstep.wav",
  hihat: "assets/hat.mp3",
  clap: "assets/clap.wav",
};

// Display names for sounds in the Sound Library UI.
// Custom uploads will be added dynamically at runtime.
const SOUND_LIBRARY_META = {
  kick: { name: "Kick" },
  snare: { name: "Snare" },
  hihat: { name: "Hi-hat" },
  clap: { name: "Clap" },
};

// Last recorded user sample (for download)
let lastRecordingBlob = null;
let lastRecordingUrl = null;

// Initial tempo / groove
let bpm = 120;
let swingPercent = 0; // 0–60

// Loop / transport / recording
let isPlaying = false;
let isLoopEnabled = true;
let isRecording = false;
let useSongMode = false;
let isMetronomeEnabled = false;

// Loop Region (optional section looping, DAW-like)
// Default region covers the full timeline so behavior stays backward compatible.
let loopRegionStartStep = 0;
let loopRegionEndStep = stepsPerTrack - 1;
let loopOverlayEl = null;
let loopMarkerStartEl = null;
let loopMarkerEndEl = null;

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
let lastPlayedStepIndex = 0;

// Time-based playback state for video-style timeline
let playbackPositionSec = 0;
let lastFrameTimeMs = null;
let playbackAnimationFrameId = null;
let lastTimelineStepIndex = -1;

// To keep references to step buttons in the grid
// stepButtons[trackIndex][stepIndex] = HTMLElement
const stepButtons = [];

// Piano roll (melody) notes
// notes: { rowIndex (0-7), stepIndex (0-15) }
const pianoRollNotes = [];

// ===== Undo / Redo (musical edits) =====
const UNDO_LIMIT = 50;
const undoStack = [];
const redoStack = [];
let undoActionBefore = null;
let isApplyingUndoState = false;

function deepClone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function captureUndoSnapshot() {
  return {
    currentPatternIndex,
    patterns: deepClone(patterns),
    pianoRollNotes: deepClone(pianoRollNotes),
  };
}

function applyUndoSnapshot(snapshot) {
  if (!snapshot) return;
  if (
    !snapshot.patterns ||
    snapshot.patterns.length !== patterns.length ||
    snapshot.patterns[0].length !== tracks.length
  ) {
    console.warn("Undo snapshot mismatch; skipping restore.");
    return;
  }

  isApplyingUndoState = true;

  currentPatternIndex = snapshot.currentPatternIndex ?? currentPatternIndex;

  for (let p = 0; p < NUM_PATTERNS; p++) {
    for (let t = 0; t < tracks.length; t++) {
      for (let s = 0; s < stepsPerTrack; s++) {
        const src = snapshot.patterns[p][t][s];
        const dest = patterns[p][t][s];
        dest.active = !!src.active;
        dest.velocity = typeof src.velocity === "number" ? src.velocity : 1;
        dest.probability =
          typeof src.probability === "number" ? src.probability : 1;
      }
    }
  }

  pianoRollNotes.length = 0;
  snapshot.pianoRollNotes.forEach((n) => pianoRollNotes.push(n));

  refreshWholePatternVisual();
  buildTimelinePatternRow();
  refreshPianoRollVisual();
  clearCurrentStepHighlight();
  highlightCurrentStep(currentStepIndex);

  isApplyingUndoState = false;
}

function beginUndoAction() {
  if (isApplyingUndoState) return;
  if (undoActionBefore) return;
  undoActionBefore = captureUndoSnapshot();
}

function commitUndoAction() {
  if (isApplyingUndoState || !undoActionBefore) return;
  const after = captureUndoSnapshot();
  undoStack.push({ before: undoActionBefore, after });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  undoActionBefore = null;
}

function cancelUndoAction() {
  undoActionBefore = null;
}

function undoAction() {
  if (isApplyingUndoState) return;
  const entry = undoStack.pop();
  if (!entry) return;
  redoStack.push(entry);
  applyUndoSnapshot(entry.before);
}

function redoAction() {
  if (isApplyingUndoState) return;
  const entry = redoStack.pop();
  if (!entry) return;
  undoStack.push(entry);
  applyUndoSnapshot(entry.after);
}

// ===== Project Save / Load =====
const PROJECT_VERSION = 1;

function getProjectSnapshot() {
  return {
    version: PROJECT_VERSION,
    id: Date.now().toString(),
    savedAt: new Date().toISOString(),
    // Global controls
    bpm,
    swingPercent,
    stepsPerTrack,
    currentPatternIndex,
    // Track lanes (dynamic)
    tracks: deepClone(tracks),
    // Mixer/FX state
    muteState: deepClone(muteState),
    soloState: deepClone(soloState),
    volumeState: deepClone(volumeState),
    panState: deepClone(panState),
    effectsState: deepClone(effectsState),
    // Loop region selection
    loopRegionStartStep,
    loopRegionEndStep,
    // Musical content
    patterns: deepClone(patterns),
    pianoRollNotes: deepClone(pianoRollNotes),
  };
}

function applyProjectSnapshot(snapshot) {
  if (!snapshot || !snapshot.patterns) return;

  // Stop transport so UI rebuilds don’t race the playback loop.
  if (isPlaying) pausePlayback();

  // Restore track lanes.
  const nextTracks = Array.isArray(snapshot.tracks)
    ? deepClone(snapshot.tracks)
    : tracks;

  // Resolve any missing sound ids to defaults so playback doesn’t break.
  const defaultTrackId = "kick";
  nextTracks.forEach((t) => {
    if (!SOUND_FILES[t.id]) {
      t.id = defaultTrackId;
      t.name = "Kick";
    }
  });

  // Mutate existing tracks array to preserve references.
  tracks.length = 0;
  nextTracks.forEach((t) => tracks.push(t));

  AudioEngine.resetAudioEngine();

  // Restore scalar globals.
  bpm = snapshot.bpm || bpm;
  swingPercent = typeof snapshot.swingPercent === "number" ? snapshot.swingPercent : swingPercent;
  stepsPerTrack = snapshot.stepsPerTrack || stepsPerTrack;
  currentPatternIndex = snapshot.currentPatternIndex ?? currentPatternIndex;

  // Sync UI controls (best-effort).
  handleBpmChange(bpm);
  handleSwingChange(swingPercent);
  const bpmSliderEl = document.getElementById("bpm-slider");
  if (bpmSliderEl) bpmSliderEl.value = String(Math.round(bpm));
  const bpmInputEl = document.getElementById("bpm-input");
  if (bpmInputEl) bpmInputEl.value = String(Math.round(bpm));
  const swingSliderEl = document.getElementById("swing-slider");
  if (swingSliderEl) swingSliderEl.value = String(Math.round(swingPercent));
  const stepCountSelectEl = document.getElementById("step-count-select");
  if (stepCountSelectEl) stepCountSelectEl.value = String(stepsPerTrack);

  // Restore per-track state arrays to match track count.
  const syncArrayToLength = (arr, values, fallbackValue) => {
    arr.length = 0;
    if (Array.isArray(values)) {
      values.forEach((v) => arr.push(v));
    } else {
      for (let i = 0; i < tracks.length; i++) arr.push(fallbackValue);
    }
  };

  syncArrayToLength(muteState, snapshot.muteState, false);
  syncArrayToLength(soloState, snapshot.soloState, false);
  syncArrayToLength(volumeState, snapshot.volumeState, 0.9);
  syncArrayToLength(panState, snapshot.panState, 0);
  // Effects state is an array of objects
  if (Array.isArray(snapshot.effectsState)) {
    effectsState.length = 0;
    snapshot.effectsState.forEach((fx) => effectsState.push(fx));
  } else {
    effectsState.length = 0;
    for (let i = 0; i < tracks.length; i++) {
      effectsState.push({
        reverb: true,
        delay: false,
        lp: false,
        hp: false,
        distortion: false,
      });
    }
  }

  // Restore loop region.
  loopRegionStartStep =
    typeof snapshot.loopRegionStartStep === "number"
      ? snapshot.loopRegionStartStep
      : 0;
  loopRegionEndStep =
    typeof snapshot.loopRegionEndStep === "number"
      ? snapshot.loopRegionEndStep
      : stepsPerTrack - 1;

  // Restore musical content
  patterns.length = 0;
  snapshot.patterns.forEach((p) => patterns.push(p));

  pianoRollNotes.length = 0;
  (snapshot.pianoRollNotes || []).forEach((n) => pianoRollNotes.push(n));

  // Rebuild UI.
  updateCssStepVariable();
  buildSequencerHeaderSteps();
  createSequencerGrid(true);
  refreshWholePatternVisual();

  createMixerUI();
  buildTimelineRuler();
  buildTimelinePatternRow();
  updateTimelineTrackAreaHeight();

  buildPianoRoll();
  if (typeof updateLoopRegionUI === "function") updateLoopRegionUI();
}

// Expose for sidebar.js.
window.getProjectSnapshot = getProjectSnapshot;
window.applyProjectSnapshot = applyProjectSnapshot;

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

  function resetAudioEngine() {
    // Used after track count changes so the internal per-track node graph matches.
    if (context) {
      try {
        context.close().catch(() => {});
      } catch {
        // ignore
      }
    }
    context = null;
    masterGain = null;
    // Clear loaded buffers so newly assigned sounds can decode cleanly.
    Object.keys(buffers).forEach((k) => delete buffers[k]);
  }

  function startMasterRecording(preferredMimeType) {
    if (typeof MediaRecorder === "undefined") return null;
    const ctx = createContextIfNeeded();
    if (!ctx || !masterGain) return null;
    const dest = ctx.createMediaStreamDestination();
    masterGain.connect(dest);

    const chunks = [];
    const mimeType = preferredMimeType || "";
    let recorder = null;

    const tryCreate = (type) => {
      try {
        const options = type && MediaRecorder.isTypeSupported(type) ? { type } : {};
        recorder = new MediaRecorder(dest.stream, options);
        return true;
      } catch {
        return false;
      }
    };

    const ok =
      (preferredMimeType && tryCreate(preferredMimeType)) ||
      tryCreate("audio/webm;codecs=opus") ||
      tryCreate("");

    if (!ok || !recorder) return null;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.start();
    return { recorder, dest, chunks, mimeType: recorder.mimeType };
  }

  function stopMasterRecording(session) {
    if (!session || !session.recorder) return Promise.resolve(null);
    const { recorder, dest, chunks, mimeType } = session;

    return new Promise((resolve) => {
      recorder.onstop = () => {
        try {
          if (masterGain && dest) {
            try {
              masterGain.disconnect(dest);
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }

        const type = mimeType || "audio/webm";
        const blob = new Blob(chunks, { type });
        resolve(blob);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
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

    // Legacy helper kept for compatibility with earlier 8-row piano roll.
    // New code should use triggerMelodyOscFrequency for true chromatic pitch.
    const baseFreq = 220; // A3
    const semitone = Math.pow(2, 1 / 12);
    const semitoneOffset = pitchRow * 2; // every row a whole step
    triggerMelodyOscFrequency(baseFreq * Math.pow(semitone, semitoneOffset), stepDurationMs);
  }

  function triggerMelodyOscFrequency(frequencyHz, stepDurationMs) {
    const ctx = createContextIfNeeded();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "square";
    osc.frequency.value = Math.max(10, Number(frequencyHz) || 220);

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
    triggerMelodyOscFrequency,
    ensureContext: createContextIfNeeded,
    preloadDrums,
    resetAudioEngine,
    startMasterRecording,
    stopMasterRecording,
  };
})();

// ===== Simple microphone recorder (Web Audio API) for user samples =====
const SampleRecorder = (() => {
  let mediaStream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let recording = false;
  let recordedBuffers = [];
  let recordingSampleRate = 44100;

  async function start() {
    if (recording) return;
    // Request mic access
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx();
    recordingSampleRate = audioContext.sampleRate;

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    recordedBuffers = [];

    processorNode.onaudioprocess = (event) => {
      if (!recording) return;
      const channelData = event.inputBuffer.getChannelData(0);
      recordedBuffers.push(new Float32Array(channelData));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    recording = true;
  }

  function stop() {
    if (!recording) return null;
    recording = false;

    if (processorNode) {
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    if (recordedBuffers.length === 0) {
      return null;
    }

    // Merge Float32 chunks into one
    const length = recordedBuffers.reduce((acc, cur) => acc + cur.length, 0);
    const merged = new Float32Array(length);
    let offset = 0;
    for (const buf of recordedBuffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }

    const wavBuffer = encodeWav(merged, recordingSampleRate);
    return new Blob([wavBuffer], { type: "audio/wav" });
  }

  function encodeWav(float32Array, sampleRate) {
    const bytesPerSample = 2;
    const numChannels = 1;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + float32Array.length * bytesPerSample);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + float32Array.length * bytesPerSample, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // PCM
    view.setUint16(20, 1, true); // linear PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(view, 36, "data");
    view.setUint32(40, float32Array.length * bytesPerSample, true);

    // Write PCM samples
    let offset = 44;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return buffer;
  }

  function writeString(view, offset, text) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  function isRecording() {
    return recording;
  }

  return {
    start,
    stop,
    isRecording,
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

// ===== Step count helpers & resizing =====
function updateCssStepVariable() {
  document.documentElement.style.setProperty("--steps", String(stepsPerTrack));
}

function resizeAllPatterns(newSteps) {
  for (let p = 0; p < NUM_PATTERNS; p++) {
    const grid = patterns[p];
    for (let t = 0; t < tracks.length; t++) {
      const oldRow = grid[t];
      const newRow = [];
      for (let s = 0; s < newSteps; s++) {
        if (s < oldRow.length) {
          newRow.push(oldRow[s]);
        } else {
          newRow.push({
            active: false,
            velocity: 1,
            probability: 1,
          });
        }
      }
      grid[t] = newRow;
    }
  }
}

function buildSequencerHeaderSteps() {
  const header = document.querySelector(".steps-header");
  if (!header) return;
  header.innerHTML = "";

  for (let i = 0; i < stepsPerTrack; i++) {
    const span = document.createElement("span");
    span.classList.add("step-number");
    const bar = Math.floor(i / 4) + 1;
    const beat = (i % 4) + 1;
    span.textContent = `${bar}.${beat}`;
    header.appendChild(span);
  }
}

function handleStepCountChange(newSteps) {
  if (!ALLOWED_STEP_COUNTS.includes(newSteps)) return;
  if (newSteps === stepsPerTrack) return;

  // Pause playback while we rebuild the grid so timing state is clean.
  const wasPlaying = isPlaying;
  if (wasPlaying) {
    pausePlayback();
  }

  resizeAllPatterns(newSteps);
  stepsPerTrack = newSteps;
  updateCssStepVariable();

  // Rebuild sequencer grid & visuals to match new step length.
  createSequencerGrid(true);
  refreshWholePatternVisual();
  buildSequencerHeaderSteps();

  // Rebuild timeline & piano roll to stay in sync.
  buildTimelineRuler();
  buildTimelinePatternRow();
  buildPianoRoll();

  // Keep loop region selection in sync with the new step count.
  loopRegionStartStep = 0;
  loopRegionEndStep = stepsPerTrack - 1;
  updateLoopRegionUI();

  currentStepIndex = 0;
  lastPlayedStepIndex = 0;
  clearCurrentStepHighlight();
  updateTimelinePlayhead(0);
}

// ===== Sequencer grid creation =====
function createSequencerGrid(isRebuild = false) {
  const grid = document.getElementById("sequencer-grid");
  if (!grid) return;

  if (isRebuild) {
    grid.innerHTML = "";
    stepButtons.length = 0;
  }

  tracks.forEach((track, trackIndex) => {
    const row = document.createElement("div");
    row.classList.add("track-row");

    // --- Left: track info (name, mute/solo, volume, pan) ---
    const info = document.createElement("div");
    info.classList.add("track-info");
    info.dataset.trackIndex = trackIndex;

    // Drag-and-drop: assign dropped sound to this track lane.
    info.addEventListener("dragover", (e) => {
      e.preventDefault();
      info.classList.add("is-drop-target");
    });
    info.addEventListener("dragleave", () => {
      info.classList.remove("is-drop-target");
    });
    info.addEventListener("drop", (e) => {
      e.preventDefault();
      info.classList.remove("is-drop-target");
      const soundId = e.dataTransfer.getData("text/sound-id");
      if (!soundId || !SOUND_FILES[soundId]) return;

      const newName = SOUND_LIBRARY_META[soundId]?.name || soundId;
      tracks[trackIndex].id = soundId;
      tracks[trackIndex].name = newName;

      // Re-render UI titles/labels; patterns do not change.
      createSequencerGrid(true);
      createMixerUI();
      buildTimelinePatternRow();
      refreshWholePatternVisual();
    });

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
    muteBtn.classList.toggle("is-active", muteState[trackIndex]);

    const soloBtn = document.createElement("button");
    soloBtn.type = "button";
    soloBtn.classList.add("solo-btn");
    soloBtn.textContent = "S";
    soloBtn.title = "Solo " + track.name;
    soloBtn.dataset.trackIndex = trackIndex;
    soloBtn.classList.toggle("is-active", soloState[trackIndex]);

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
  beginUndoAction();
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
  buildTimelinePatternRow();
  commitUndoAction();
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
  beginUndoAction();
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
  buildTimelinePatternRow();
  commitUndoAction();
}

function randomizePattern() {
  beginUndoAction();
  // Different "density" per track to sound musical
  const densityByTrack = [0.45, 0.3, 0.65, 0.2]; // kick, snare, hihat, clap
  const defaultDensity = 0.35;
  const grid = getCurrentPatternGrid();

  for (let t = 0; t < tracks.length; t++) {
    const density = densityByTrack[t] ?? defaultDensity;
    for (let s = 0; s < stepsPerTrack; s++) {
      const active = Math.random() < density;
      const step = grid[t][s];
      step.active = active;
      step.velocity = active ? 0.8 + Math.random() * 0.2 : 1;
      step.probability = active ? 0.8 + Math.random() * 0.2 : 1;
      updateStepVisual(t, s);
    }
  }
  buildTimelinePatternRow();
  commitUndoAction();
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
}

// ===== Timeline / pattern chain rendering =====
function buildTimelineRuler() {
  const ruler = document.getElementById("timeline-ruler");
  ruler.innerHTML = "";
  // One label per sequencer step: 1, 2, 3, ...
  for (let i = 0; i < stepsPerTrack; i++) {
    const cell = document.createElement("div");
    cell.classList.add("timeline-ruler-cell");
    cell.textContent = String(i + 1);
    ruler.appendChild(cell);
  }
}

function buildTimelinePatternRow() {
  const clipsContainer = document.getElementById("timeline-clips");
  if (!clipsContainer) return;
  clipsContainer.innerHTML = "";

  const totalSteps = stepsPerTrack;
  const grid = getCurrentPatternGrid();

  tracks.forEach((track, trackIndex) => {
    let stepIndex = 0;
    while (stepIndex < stepsPerTrack) {
      const step = grid[trackIndex][stepIndex];
      if (!step.active) {
        stepIndex++;
        continue;
      }

      // Build a "clip" from contiguous active steps.
      const startStep = stepIndex;
      const velocities = [];
      const probabilities = [];
      while (
        stepIndex < stepsPerTrack &&
        grid[trackIndex][stepIndex] &&
        grid[trackIndex][stepIndex].active
      ) {
        velocities.push(grid[trackIndex][stepIndex].velocity);
        probabilities.push(grid[trackIndex][stepIndex].probability);
        stepIndex++;
      }

      const durationSteps = velocities.length;
      const leftPercent = (startStep / totalSteps) * 100;
      const clipWidthPercent = (durationSteps / totalSteps) * 100;

      const clip = document.createElement("div");
      clip.classList.add("timeline-clip");
      clip.dataset.trackIndex = String(trackIndex);
      clip.dataset.startStep = String(startStep);
      clip.dataset.durationSteps = String(durationSteps);
      // Backward compatibility for older handlers/debugging.
      clip.dataset.stepIndex = String(startStep);

      clip.style.left = `${leftPercent}%`;
      clip.style.width = `${clipWidthPercent}%`;

      const trackRowHeight = 16;
      const trackGap = 4;
      const topPx = trackIndex * (trackRowHeight + trackGap) + 6;
      clip.style.top = `${topPx}px`;

      enableClipDragging(clip);
      clipsContainer.appendChild(clip);
    }
  });
}

function refreshTimelinePatternRow() {
  // Rebuild clips from the current pattern grid
  buildTimelinePatternRow();
}

function updateTimelinePlayhead(stepIndex) {
  // No-op: timeline position is now driven by continuous playback time,
  // see updateTimelineFromPlaybackPosition.
}

// ===== Piano roll rendering & logic =====
// Chromatic scale rows (real piano keys) for a more DAW-like piano roll.
// Keep this self-contained so the rest of the DAW can remain unchanged.
const PIANO_ROLL_BASE_MIDI = 60; // C4
const PIANO_ROLL_NUM_KEYS = 12; // C4..B4 (1 octave)
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function isBlackKey(noteName) {
  return noteName.includes("#");
}

function buildPianoRoll() {
  const keysContainer = document.getElementById("piano-roll-keys");
  const gridContainer = document.getElementById("piano-roll-grid");

  keysContainer.innerHTML = "";
  gridContainer.innerHTML = "";

  // Ensure CSS grid matches the number of piano keys
  document.documentElement.style.setProperty(
    "--piano-rows",
    String(PIANO_ROLL_NUM_KEYS),
  );

  // Row 0 is the TOP visually. We'll render highest note at the top like most DAWs.
  for (let rowIndex = 0; rowIndex < PIANO_ROLL_NUM_KEYS; rowIndex++) {
    const semitoneFromBase = PIANO_ROLL_NUM_KEYS - 1 - rowIndex; // top = highest
    const noteName = NOTE_NAMES[(PIANO_ROLL_BASE_MIDI + semitoneFromBase) % 12];
    const octave = Math.floor((PIANO_ROLL_BASE_MIDI + semitoneFromBase) / 12) - 1;
    const label = `${noteName}${octave}`;

    const key = document.createElement("button");
    key.type = "button";
    key.classList.add("piano-roll-key");
    key.classList.toggle("is-black", isBlackKey(noteName));
    key.dataset.semitone = String(semitoneFromBase);
    key.textContent = label;
    key.addEventListener("click", () => {
      // Audition note on click (doesn't change sequencer state)
      const stepDurationMs = getStepIntervalMs(bpm);
      const midi = PIANO_ROLL_BASE_MIDI + semitoneFromBase;
      AudioEngine.triggerMelodyOscFrequency(midiToFrequency(midi), stepDurationMs);
    });
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
  beginUndoAction();
  const existingIndex = pianoRollNotes.findIndex(
    (n) => n.rowIndex === rowIndex && n.stepIndex === stepIndex,
  );

  if (existingIndex !== -1) {
    pianoRollNotes.splice(existingIndex, 1);
  } else {
    pianoRollNotes.push({ rowIndex, stepIndex });
  }
  refreshPianoRollVisual();
  commitUndoAction();
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
      // Backward compatible: older saves store rowIndex in an 8-row grid.
      // If rowIndex is outside the new range, clamp it into our chromatic rows.
      const safeRowIndex = Math.max(
        0,
        Math.min(PIANO_ROLL_NUM_KEYS - 1, Number(note.rowIndex) || 0),
      );
      const semitoneFromBase = PIANO_ROLL_NUM_KEYS - 1 - safeRowIndex;
      const midi = PIANO_ROLL_BASE_MIDI + semitoneFromBase;
      AudioEngine.triggerMelodyOscFrequency(midiToFrequency(midi), stepDurationMs);
    }
  });
}

function triggerMetronomeClick(stepIndex) {
  if (!isMetronomeEnabled) return;
  const ctx = AudioEngine.ensureContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const accent = stepIndex % 16 === 0; // downbeat accent (every 4 beats)

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "square";
  osc.frequency.value = accent ? 1000 : 700;

  // Very short envelope so it feels like a click.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(accent ? 0.18 : 0.11, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + 0.04);
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

  // Optional metronome click (quarter-note grid: every 4 steps)
  if (isMetronomeEnabled && stepIndex % 4 === 0) {
    triggerMetronomeClick(stepIndex);
  }
}

function stepTick() {
  // Deprecated in favor of time-based playback; kept for compatibility.
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
  // Deprecated in favor of requestAnimationFrame-driven playback.
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

  lastFrameTimeMs = performance.now();
  playbackAnimationFrameId = window.requestAnimationFrame(
    playbackAnimationLoop,
  );
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
  if (playbackAnimationFrameId !== null) {
    window.cancelAnimationFrame(playbackAnimationFrameId);
    playbackAnimationFrameId = null;
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

  if (playbackAnimationFrameId !== null) {
    window.cancelAnimationFrame(playbackAnimationFrameId);
    playbackAnimationFrameId = null;
  }

  playbackPositionSec = 0;
  lastFrameTimeMs = null;
  lastTimelineStepIndex = -1;

  currentStepIndex = 0;
  lastPlayedStepIndex = 0;
  clearCurrentStepHighlight();
  updateTimelineFromPlaybackPosition();

  // Stopping transport should also stop recording.
  const recordToggle = document.getElementById("record-toggle");
  if (recordToggle) {
    isRecording = false;
    recordToggle.classList.remove("btn-toggle-active");
  }
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

// ===== Timeline helpers for time-based playback =====
function getSecondsPerStep() {
  return 60 / bpm / 4;
}

function getTotalDurationSeconds() {
  return stepsPerTrack * getSecondsPerStep();
}

function updateTimelineTrackAreaHeight() {
  const area = document.getElementById("timeline-track-area");
  if (!area) return;
  // Matches buildTimelinePatternRow layout:
  // top = trackIndex*(16+4)+6, clip height ~14
  const trackRowHeight = 16;
  const trackGap = 4;
  const topOffsetPx = 6;
  const clipHeightPx = 14;
  const needed =
    (tracks.length - 1) * (trackRowHeight + trackGap) +
    topOffsetPx +
    clipHeightPx;
  area.style.height = `${Math.max(72, needed)}px`;
}

function createEmptyTrackSteps() {
  return Array.from({ length: stepsPerTrack }, () => ({
    active: false,
    velocity: 1,
    probability: 1,
  }));
}

function addTrackLane(soundId = "kick") {
  if (isPlaying) pausePlayback();

  const nextIndex = tracks.length;
  let resolvedSoundId = soundId;

  const niceName =
    resolvedSoundId === "kick"
      ? "Kick"
      : resolvedSoundId === "snare"
        ? "Snare"
        : resolvedSoundId === "hihat"
          ? "Hi-hat"
          : resolvedSoundId === "clap"
            ? "Clap"
            : `Track ${nextIndex + 1}`;

  if (!SOUND_FILES[resolvedSoundId]) {
    resolvedSoundId = "kick";
  }

  tracks.push({ id: resolvedSoundId, name: niceName, key: "" });
  muteState.push(false);
  soloState.push(false);
  volumeState.push(0.9);
  panState.push(0);
  effectsState.push({
    reverb: true,
    delay: false,
    lp: false,
    hp: false,
    distortion: false,
  });

  for (let p = 0; p < patterns.length; p++) {
    patterns[p].push(createEmptyTrackSteps());
  }

  // Rebuild UI that depends on track count.
  AudioEngine.resetAudioEngine();
  updateTimelineTrackAreaHeight();
  createSequencerGrid(true);
  buildSequencerHeaderSteps();
  refreshWholePatternVisual();
  createMixerUI();
  buildTimelinePatternRow();
  clearCurrentStepHighlight();
  highlightCurrentStep(currentStepIndex);
}

function removeLastTrackLane() {
  if (tracks.length <= 1) return;
  if (isPlaying) pausePlayback();

  tracks.pop();
  muteState.pop();
  soloState.pop();
  volumeState.pop();
  panState.pop();
  effectsState.pop();

  for (let p = 0; p < patterns.length; p++) {
    patterns[p].pop();
  }

  AudioEngine.resetAudioEngine();
  updateTimelineTrackAreaHeight();
  createSequencerGrid(true);
  buildSequencerHeaderSteps();
  refreshWholePatternVisual();
  createMixerUI();
  buildTimelinePatternRow();
  clearCurrentStepHighlight();
  highlightCurrentStep(currentStepIndex);
}

function getLoopRegionBoundsSeconds() {
  const totalSteps = stepsPerTrack;
  const safeStart = Math.max(0, Math.min(totalSteps - 1, loopRegionStartStep));
  const safeEnd = Math.max(safeStart, Math.min(totalSteps - 1, loopRegionEndStep));

  const secondsPerStep = getSecondsPerStep();
  const startSec = safeStart * secondsPerStep;
  // end is inclusive in UI; convert to exclusive time boundary for looping.
  const endSec = (safeEnd + 1) * secondsPerStep;
  const durationSec = Math.max(0, endSec - startSec);

  return { safeStart, safeEnd, startSec, endSec, durationSec };
}

function updateLoopRegionUI() {
  if (!loopOverlayEl || !loopMarkerStartEl || !loopMarkerEndEl) return;

  const totalSteps = stepsPerTrack;
  const { safeStart, safeEnd } = getLoopRegionBoundsSeconds();

  // Marker positions at step boundaries:
  // - start marker aligns with start step boundary
  // - end marker aligns with the boundary after the end step
  const startLeftPct = (safeStart / totalSteps) * 100;
  const endBoundaryStep = safeEnd + 1;
  const endLeftPct = (endBoundaryStep / totalSteps) * 100;
  const overlayWidthPct = ((endBoundaryStep - safeStart) / totalSteps) * 100;

  // Half the marker width (CSS uses 3px).
  const halfMarkerPx = 1.5;

  loopOverlayEl.style.left = `${startLeftPct}%`;
  loopOverlayEl.style.width = `${overlayWidthPct}%`;

  loopMarkerStartEl.style.left = `calc(${startLeftPct}% - ${halfMarkerPx}px)`;
  loopMarkerEndEl.style.left = `calc(${endLeftPct}% - ${halfMarkerPx}px)`;
}

function initLoopRegionSelection() {
  const trackArea = document.getElementById("timeline-track-area");
  if (!trackArea) return;

  loopOverlayEl = document.getElementById("timeline-loop-overlay");
  loopMarkerStartEl = document.getElementById("timeline-loop-marker-start");
  loopMarkerEndEl = document.getElementById("timeline-loop-marker-end");

  if (!loopOverlayEl || !loopMarkerStartEl || !loopMarkerEndEl) return;

  // Ensure the UI starts in "full timeline loop" mode.
  loopRegionStartStep = 0;
  loopRegionEndStep = stepsPerTrack - 1;
  updateLoopRegionUI();

  function stepFromPointerClientX(clientX) {
    const rect = trackArea.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, rect.left), rect.right);
    const fraction = rect.width > 0 ? (x - rect.left) / rect.width : 0;
    const totalSteps = stepsPerTrack;
    return Math.max(
      0,
      Math.min(totalSteps - 1, Math.floor(fraction * totalSteps)),
    );
  }

  let dragType = null; // "start" | "end"

  function onMouseMove(e) {
    if (!dragType) return;
    const newStep = stepFromPointerClientX(e.clientX);
    if (dragType === "start") {
      loopRegionStartStep = Math.min(newStep, loopRegionEndStep);
    } else if (dragType === "end") {
      loopRegionEndStep = Math.max(newStep, loopRegionStartStep);
    }
    updateLoopRegionUI();
  }

  function onMouseUp() {
    dragType = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  loopMarkerStartEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragType = "start";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });

  loopMarkerEndEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragType = "end";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });

  // Prevent the track click handler from seeking when clicking markers.
  loopMarkerStartEl.addEventListener("click", (e) => e.stopPropagation());
  loopMarkerEndEl.addEventListener("click", (e) => e.stopPropagation());
}

function updateTimelineFromPlaybackPosition() {
  const duration = getTotalDurationSeconds();
  if (duration <= 0) return;

  const fraction = Math.max(
    0,
    Math.min(1, playbackPositionSec / duration),
  );

  const playhead = document.getElementById("timeline-playhead");

  if (playhead) {
    playhead.style.transform = `translateX(${fraction * 100}%)`;
  }

  const secondsPerStep = getSecondsPerStep();
  const stepIndex = Math.max(
    0,
    Math.min(
      stepsPerTrack - 1,
      Math.floor(playbackPositionSec / secondsPerStep),
    ),
  );

  if (stepIndex !== lastTimelineStepIndex) {
    lastTimelineStepIndex = stepIndex;
    lastPlayedStepIndex = stepIndex;
    currentStepIndex = stepIndex;
    clearCurrentStepHighlight();
    highlightCurrentStep(stepIndex);
    playCurrentStep(stepIndex);
  }
}

function playbackAnimationLoop(timestamp) {
  if (!isPlaying) return;

  if (lastFrameTimeMs == null) {
    lastFrameTimeMs = timestamp;
  }

  const deltaMs = timestamp - lastFrameTimeMs;
  lastFrameTimeMs = timestamp;

  playbackPositionSec += deltaMs / 1000;

  const totalDuration = getTotalDurationSeconds();
  if (totalDuration > 0) {
    if (isLoopEnabled) {
      const { startSec, endSec, durationSec } =
        getLoopRegionBoundsSeconds();
      if (durationSec > 0 && playbackPositionSec >= endSec) {
        playbackPositionSec =
          startSec +
          ((playbackPositionSec - startSec) % durationSec);
      }
    } else if (playbackPositionSec >= totalDuration) {
      stopPlayback();
      return;
    }
  }

  updateTimelineFromPlaybackPosition();

  playbackAnimationFrameId = window.requestAnimationFrame(
    playbackAnimationLoop,
  );
}

function seekTimelineToFraction(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const duration = getTotalDurationSeconds();
  playbackPositionSec = clamped * duration;
  lastTimelineStepIndex = -1; // force step re-trigger on next update
  updateTimelineFromPlaybackPosition();
}

function setupTimelineInteractions() {
  const trackArea = document.getElementById("timeline-track-area");
  if (!trackArea) return;

  trackArea.addEventListener("click", (event) => {
    // Ignore clicks that start on clips (dragging is handled separately)
    if (
      event.target instanceof HTMLElement &&
      (event.target.classList.contains("timeline-clip") ||
        event.target.classList.contains("timeline-loop-marker"))
    ) {
      return;
    }

    const rect = trackArea.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const fraction = rect.width > 0 ? x / rect.width : 0;
    seekTimelineToFraction(fraction);
  });
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
  buildTimelinePatternRow();
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

// ===== Timeline clip dragging =====
function enableClipDragging(clipElement) {
  clipElement.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginUndoAction();

    const trackArea = document.getElementById("timeline-track-area");
    const clipsContainer = document.getElementById("timeline-clips");
    if (!trackArea || !clipsContainer) return;

    const trackIndex = Number(clipElement.dataset.trackIndex || 0);
    const totalSteps = stepsPerTrack;

    // New: range-based clips (start+duration). Backward compatible with old dataset.stepIndex.
    const startStep = Number(clipElement.dataset.startStep || clipElement.dataset.stepIndex || 0);
    const durationSteps = Math.max(
      1,
      Number(clipElement.dataset.durationSteps || 1),
    );

    const clipWidthPercent = (durationSteps / totalSteps) * 100;
    const areaRect = trackArea.getBoundingClientRect();

    // Snapshot payload from the grid at drag start.
    const grid = getCurrentPatternGrid();
    const payloadVelocities = [];
    const payloadProbabilities = [];
    for (let j = 0; j < durationSteps; j++) {
      const idx = startStep + j;
      const step = grid[trackIndex][idx];
      payloadVelocities.push(step ? step.velocity : 1);
      payloadProbabilities.push(step ? step.probability : 1);
    }

    // Move vs duplicate (Alt+Drag duplicates).
    const shouldDuplicate = !!event.altKey;

    // Common pointer->step mapping (snap to clip left edge).
    function candidateStartFromClientX(clientX) {
      const x = Math.min(Math.max(clientX, areaRect.left), areaRect.right);
      const fraction = areaRect.width > 0 ? (x - areaRect.left) / areaRect.width : 0;
      const candidate = Math.floor(fraction * totalSteps);
      return Math.max(0, Math.min(totalSteps - durationSteps, candidate));
    }

    // ----- MOVE CLIP -----
    if (!shouldDuplicate) {
      let lastStartApplied = startStep;
      clipElement.dataset.startStep = String(startStep);
      clipElement.dataset.durationSteps = String(durationSteps);
      clipElement.style.width = `${clipWidthPercent}%`;

      function applyMoveTo(newStart) {
        if (newStart === lastStartApplied) return;

        // Clear previous location.
        for (let j = 0; j < durationSteps; j++) {
          const idx = lastStartApplied + j;
          const step = grid[trackIndex][idx];
          if (!step) continue;
          step.active = false;
          step.velocity = 1;
          step.probability = 1;
        }

        // Apply new location with original payload.
        for (let j = 0; j < durationSteps; j++) {
          const idx = newStart + j;
          const step = grid[trackIndex][idx];
          if (!step) continue;
          step.active = true;
          step.velocity = payloadVelocities[j];
          step.probability = payloadProbabilities[j];
        }

        lastStartApplied = newStart;
        clipElement.dataset.startStep = String(newStart);
        clipElement.dataset.stepIndex = String(newStart);
        const leftPercent = (newStart / totalSteps) * 100;
        clipElement.style.left = `${leftPercent}%`;

        refreshWholePatternVisual();
      }

      function onMouseMove(moveEvent) {
        const newStart = candidateStartFromClientX(moveEvent.clientX);
        applyMoveTo(newStart);
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        // Rebuild clips so adjacency merges/splits look correct.
        buildTimelinePatternRow();
        commitUndoAction();
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      return;
    }

    // ----- DUPLICATE CLIP -----
    const originalStartStep = startStep;
    const originalEndStep = startStep + durationSteps - 1;

    // Preview visual follows the mouse while we place a copy in the grid.
    const previewClip = document.createElement("div");
    previewClip.classList.add("timeline-clip");
    previewClip.dataset.trackIndex = String(trackIndex);
    previewClip.dataset.startStep = String(originalStartStep);
    previewClip.dataset.durationSteps = String(durationSteps);
    previewClip.dataset.stepIndex = String(originalStartStep);
    previewClip.style.top = clipElement.style.top;
    previewClip.style.height = clipElement.style.height;
    previewClip.style.width = `${clipWidthPercent}%`;
    previewClip.style.left = `${(originalStartStep / totalSteps) * 100}%`;
    clipsContainer.appendChild(previewClip);

    let lastDupStart = null;

    function canPlaceDuplicateAt(candidateStart) {
      for (let j = 0; j < durationSteps; j++) {
        const idx = candidateStart + j;
        const step = grid[trackIndex][idx];
        if (!step) continue;
        const overlappingOriginal = idx >= originalStartStep && idx <= originalEndStep;
        if (step.active && !overlappingOriginal) return false;
      }
      return true;
    }

    function clearDuplicateRange(prevStart) {
      if (prevStart == null) return;
      for (let j = 0; j < durationSteps; j++) {
        const idx = prevStart + j;
        const overlappingOriginal = idx >= originalStartStep && idx <= originalEndStep;
        if (overlappingOriginal) continue;
        const step = grid[trackIndex][idx];
        if (!step) continue;
        step.active = false;
        step.velocity = 1;
        step.probability = 1;
      }
    }

    function applyDuplicateAt(candidateStart) {
      // Remove previous duplicate.
      clearDuplicateRange(lastDupStart);

      // Place new duplicate.
      for (let j = 0; j < durationSteps; j++) {
        const idx = candidateStart + j;
        const overlappingOriginal = idx >= originalStartStep && idx <= originalEndStep;
        const step = grid[trackIndex][idx];
        if (!step) continue;
        if (overlappingOriginal) continue; // don't overwrite original payload
        step.active = true;
        step.velocity = payloadVelocities[j];
        step.probability = payloadProbabilities[j];
      }

      lastDupStart = candidateStart;
      previewClip.dataset.startStep = String(candidateStart);
      previewClip.dataset.stepIndex = String(candidateStart);
      previewClip.style.left = `${(candidateStart / totalSteps) * 100}%`;
      refreshWholePatternVisual();
    }

    // Try to seed the duplicate to the right (better UX than overlaying original).
    const seededStart = Math.min(totalSteps - durationSteps, originalStartStep + durationSteps);
    if (seededStart >= 0 && seededStart !== originalStartStep && canPlaceDuplicateAt(seededStart)) {
      applyDuplicateAt(seededStart);
      previewClip.style.left = `${(seededStart / totalSteps) * 100}%`;
    }

    function onMouseMove(moveEvent) {
      const candidateStart = candidateStartFromClientX(moveEvent.clientX);
      const valid = canPlaceDuplicateAt(candidateStart);
      previewClip.style.opacity = valid ? "1" : "0.45";
      if (!valid) return;
      if (candidateStart === lastDupStart) return;
      applyDuplicateAt(candidateStart);
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      previewClip.remove();
      buildTimelinePatternRow();
      commitUndoAction();
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
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

    // Don't steal keyboard focus from form controls.
    const tag = event.target && event.target.tagName ? event.target.tagName : "";
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;

    // Undo / Redo: Ctrl/Cmd+Z / Ctrl/Cmd+Y (and Ctrl/Cmd+Shift+Z for redo)
    if (event.code === "KeyZ" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) {
        redoAction();
      } else {
        undoAction();
      }
      return;
    }
    if (event.code === "KeyY" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      redoAction();
      return;
    }

    // Space = play/stop
    if (event.code === "Space") {
      event.preventDefault();
      if (isPlaying) {
        pausePlayback();
      } else {
        startPlayback();
      }
      return;
    }

    // Numbers = trigger corresponding drum pad (1..4)
    const n = Number(event.key);
    if (!Number.isNaN(n) && n >= 1 && n <= tracks.length) {
      const trackIndex = n - 1;
      const soundId = tracks[trackIndex].id;

      let velocity = 0.9;
      if (event.shiftKey) velocity = 1;
      if (event.altKey) velocity = 0.6;

      playSound(soundId, trackIndex, velocity);
      if (isRecording && isPlaying) {
        recordHitToSequencer(trackIndex, velocity);
      }

      const matchingPad = Array.from(pads).find(
        (pad) => pad.dataset.sound === soundId,
      );
      if (matchingPad) triggerPadAnimation(matchingPad);
      return;
    }

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

// ===== Export =====
async function exportBeatToWav() {
  const exportBtn = document.getElementById("export-beat-button");
  if (exportBtn) exportBtn.disabled = true;

  // Stop transport so we can play deterministically for export.
  if (isPlaying) pausePlayback();

  const prevLoopEnabled = isLoopEnabled;
  const prevMetronome = isMetronomeEnabled;

  // For export, don’t loop during playback; start at the region start and stop after region duration.
  isLoopEnabled = false;
  isMetronomeEnabled = false;

  const region = getLoopRegionBoundsSeconds();
  const totalDuration = getTotalDurationSeconds();
  const exportStartSec = prevLoopEnabled ? region.startSec : 0;
  const exportDurationSec = prevLoopEnabled ? region.durationSec : totalDuration;

  const safeDuration = exportDurationSec > 0 ? exportDurationSec : totalDuration;

  // Prepare timeline/step state.
  playbackPositionSec = exportStartSec;
  lastFrameTimeMs = null;
  lastTimelineStepIndex = -1;
  currentStepIndex = 0;
  clearCurrentStepHighlight();

  // Start master recording.
  const session = AudioEngine.startMasterRecording("audio/wav");
  if (!session) {
    isLoopEnabled = prevLoopEnabled;
    isMetronomeEnabled = prevMetronome;
    if (exportBtn) exportBtn.disabled = false;
    alert("Export is not supported in this browser (MediaRecorder WAV failed).");
    return;
  }

  // Start playback for the recording duration.
  AudioEngine.preloadDrums().catch(() => {});
  startPlayback();

  await new Promise((r) => setTimeout(r, safeDuration * 1000 + 250));

  // Stop transport without triggering any extra step playback.
  pausePlayback();

  const blob = await AudioEngine.stopMasterRecording(session);
  isLoopEnabled = prevLoopEnabled;
  isMetronomeEnabled = prevMetronome;
  if (exportBtn) exportBtn.disabled = false;

  if (!blob) return;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const isWav = blob.type && blob.type.includes("wav");
  const ext = isWav ? "wav" : "webm";
  a.href = url;
  a.download = `beatbox-export-${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function recordHitToSequencer(trackIndex, velocity) {
  beginUndoAction();
  const grid = getCurrentPatternGrid();
  const stepIndex = Math.max(
    0,
    Math.min(stepsPerTrack - 1, lastPlayedStepIndex),
  );
  const step = grid[trackIndex][stepIndex];
  step.active = true;
  step.velocity = velocity;
  step.probability = 1;
  updateStepVisual(trackIndex, stepIndex);
  buildTimelinePatternRow();
  commitUndoAction();
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
  const bpmInput = document.getElementById("bpm-input");
  const loopToggle = document.getElementById("loop-toggle");
  const metronomeToggle = document.getElementById("metronome-toggle");
  const recordToggle = document.getElementById("record-toggle");
  const addTrackBtn = document.getElementById("add-track-button");
  const removeTrackBtn = document.getElementById("remove-track-button");
  const stepCountSelect = document.getElementById("step-count-select");
  const patternSelect = null;
  const patternSave = null;
  const patternDuplicate = null;

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
    if (bpmInput) bpmInput.value = String(Math.round(bpm));
  });

  if (bpmInput) {
    bpmInput.value = String(Math.round(bpm));
    bpmInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (Number.isNaN(value)) return;
      const clamped = Math.max(60, Math.min(180, value));
      handleBpmChange(clamped);
      bpmSlider.value = String(clamped);
      bpmInput.value = String(clamped);
    });
  }

  swingSlider.addEventListener("input", (event) => {
    const newSwing = Number(event.target.value) || 0;
    handleSwingChange(newSwing);
  });

  // Loop toggle
  loopToggle.addEventListener("click", () => {
    isLoopEnabled = !isLoopEnabled;
    loopToggle.classList.toggle("btn-toggle-active", isLoopEnabled);
  });

  if (metronomeToggle) {
    metronomeToggle.addEventListener("click", () => {
      isMetronomeEnabled = !isMetronomeEnabled;
      metronomeToggle.classList.toggle(
        "btn-toggle-active",
        isMetronomeEnabled,
      );
    });
  }

  // Record toggle
  recordToggle.addEventListener("click", () => {
    isRecording = !isRecording;
    recordToggle.classList.toggle("btn-toggle-active", isRecording);
  });

  // Step count selector
  if (stepCountSelect) {
    stepCountSelect.value = String(stepsPerTrack);
    stepCountSelect.addEventListener("change", (event) => {
      const value = Number(event.target.value) || stepsPerTrack;
      handleStepCountChange(value);
    });
  }

  // Track lanes
  if (addTrackBtn) {
    addTrackBtn.addEventListener("click", () => {
      addTrackLane();
      if (removeTrackBtn) removeTrackBtn.disabled = tracks.length <= 1;
    });
  }

  if (removeTrackBtn) {
    removeTrackBtn.disabled = tracks.length <= 1;
    removeTrackBtn.addEventListener("click", () => {
      removeLastTrackLane();
      removeTrackBtn.disabled = tracks.length <= 1;
    });
  }

  const exportBtn = document.getElementById("export-beat-button");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      exportBeatToWav().catch((e) => console.error("Export failed", e));
    });
  }

  // Pattern select/save/duplicate
  // Pattern select/save/duplicate removed from the new timeline UI.

  // Show starting BPM & swing
  document.getElementById("bpm-value").textContent = String(bpm);
  if (bpmInput) bpmInput.value = String(Math.round(bpm));
  document.getElementById("swing-value").textContent =
    String(Math.round(swingPercent));
}

// ===== Sample upload / record / download UI =====
function getSelectedSampleTargetId() {
  const select = document.getElementById("sample-target-select");
  if (!select) return "kick";
  const value = select.value || "kick";
  return tracks.some((t) => t.id === value) ? value : "kick";
}

function assignSampleToTrackFromUrl(trackId, url) {
  // Update the SOUND_FILES mapping so subsequent playback uses the new audio
  SOUND_FILES[trackId] = url;
  // Clear any cached buffer so it reloads from the new URL
  // (AudioEngine buffers are keyed by soundId, so removing lets it reload.)
  // We can't access the internal buffers map here cleanly, but on next trigger
  // AudioEngine.loadBuffer will fetch/decode the new URL.
}

async function handleSampleFileChosen(file) {
  if (!file) return;
  const targetId = getSelectedSampleTargetId();
  const objectUrl = URL.createObjectURL(file);
  assignSampleToTrackFromUrl(targetId, objectUrl);
}

async function startSampleRecording(buttonEl, downloadBtn) {
  try {
    buttonEl.disabled = true;
    buttonEl.textContent = "Requesting Mic…";
    await SampleRecorder.start();
    buttonEl.disabled = false;
    buttonEl.textContent = "Stop Recording";
    buttonEl.classList.add("btn-toggle-active");
    if (downloadBtn) {
      downloadBtn.disabled = true;
    }
  } catch (err) {
    console.error("Error starting recording", err);
    buttonEl.disabled = false;
    buttonEl.textContent = "Record Sample";
    buttonEl.classList.remove("btn-toggle-active");
  }
}

async function stopSampleRecording(buttonEl, downloadBtn) {
  try {
    const blob = SampleRecorder.stop();
    buttonEl.textContent = "Record Sample";
    buttonEl.classList.remove("btn-toggle-active");
    if (!blob) {
      return;
    }
    lastRecordingBlob = blob;
    if (lastRecordingUrl) {
      URL.revokeObjectURL(lastRecordingUrl);
    }
    lastRecordingUrl = URL.createObjectURL(blob);
    const targetId = getSelectedSampleTargetId();
    assignSampleToTrackFromUrl(targetId, lastRecordingUrl);
    if (downloadBtn) {
      downloadBtn.disabled = false;
    }
  } catch (err) {
    console.error("Error stopping recording", err);
  }
}

function downloadLastRecording() {
  if (!lastRecordingBlob) return;
  const url = URL.createObjectURL(lastRecordingBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "beatbox-recording.wav";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setupSampleTools() {
  const uploadBtn = document.getElementById("upload-sample-button");
  const recordBtn = document.getElementById("record-sample-button");
  const downloadBtn = document.getElementById("download-sample-button");
  const fileInput = document.getElementById("sample-file-input");

  if (!uploadBtn || !recordBtn || !downloadBtn || !fileInput) {
    return;
  }

  uploadBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    handleSampleFileChosen(file);
    // reset so selecting the same file again still fires change
    event.target.value = "";
  });

  recordBtn.addEventListener("click", () => {
    if (!SampleRecorder.isRecording()) {
      startSampleRecording(recordBtn, downloadBtn);
    } else {
      stopSampleRecording(recordBtn, downloadBtn);
    }
  });

  downloadBtn.addEventListener("click", () => {
    downloadLastRecording();
  });
}

function getSoundLibraryItems() {
  const builtInOrder = ["kick", "snare", "hihat", "clap"];
  const ids = Object.keys(SOUND_FILES);

  const builtIn = builtInOrder.filter((id) => ids.includes(id));
  const customs = ids
    .filter((id) => !builtInOrder.includes(id))
    .slice()
    .sort((a, b) => a.localeCompare(b));

  return [...builtIn, ...customs].map((id) => ({
    id,
    name: SOUND_LIBRARY_META[id]?.name || id,
  }));
}

function renderSoundLibrary() {
  const list = document.getElementById("sound-library-list");
  if (!list) return;

  list.innerHTML = "";

  const items = getSoundLibraryItems();
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "sound-library-item";
    el.draggable = true;
    el.dataset.soundId = item.id;
    el.title = item.id;

    const name = document.createElement("span");
    name.textContent = item.name;

    const meta = document.createElement("span");
    meta.style.fontSize = "0.7rem";
    meta.style.color = "#9ca3af";
    meta.textContent = item.id;

    el.appendChild(name);
    el.appendChild(meta);

    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/sound-id", item.id);
      e.dataTransfer.effectAllowed = "copy";
    });

    list.appendChild(el);
  });
}

function setupSoundLibraryTools() {
  const uploadBtn = document.getElementById("upload-custom-sound-button");
  const fileInput = document.getElementById("custom-sound-file-input");
  if (!uploadBtn || !fileInput) return;

  let customCounter = 0;

  uploadBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const objectUrl = URL.createObjectURL(file);
    const idBase = file.name.replace(/\.[^/.]+$/, "");
    customCounter++;
    const soundId = `custom_${idBase}_${Date.now()}_${customCounter}`;

    SOUND_FILES[soundId] = objectUrl;
    SOUND_LIBRARY_META[soundId] = { name: idBase };

    renderSoundLibrary();
    // Allow selecting the same file again
    event.target.value = "";
  });
}

// ===== Initialization =====
document.addEventListener("DOMContentLoaded", () => {
  updateCssStepVariable();

  // Build sequencer UI
  createSequencerGrid();
  buildSequencerHeaderSteps();

  // Setup pads + keyboard
  setupPads();

  // Mixer, timeline, piano roll
  createMixerUI();
  buildTimelineRuler();
  buildTimelinePatternRow();
  updateTimelineTrackAreaHeight();
  buildPianoRoll();

  // Loop region markers + overlay
  initLoopRegionSelection();

  // Sound library
  renderSoundLibrary();
  setupSoundLibraryTools();

  // Setup transport / pattern / global controls
  setupTransportAndControls();
  setupSampleTools();
  setupTimelineInteractions();
});
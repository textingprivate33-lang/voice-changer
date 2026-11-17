import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";

const $ = (id) => document.getElementById(id);
const listenBtn = $("listenBtn");
const speakBtn = $("speakBtn");
const saveBtn = $("saveBtn");
const heard = $("heard");
const statusEl = $("status");
const outSel = $("outSel");
const voiceBtns = [...document.querySelectorAll("#voiceSwitch button")];

let tts = null;
let voice = "af_heart";
let listening = false;
let recog = null;
let sentLen = 0;          // how much of the current recognition transcript was already sent
let flushTimer = null;
let sinkId = "";
const PAUSE_MS = 650;     // pause that counts as "end of phrase"
const MAX_WORDS = 10;     // force a chunk if a phrase gets this long
const allClips = [];      // Float32Array clips, for "Save as audio clip"
let sampleRate = 24000;

const setStatus = (t) => (statusEl.textContent = t);

// ---------- Kokoro model ----------
async function loadModel() {
  setStatus("Downloading voice model (first time only, may take a minute)…");
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  try {
    tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: device === "webgpu" ? "fp32" : "q8",
      device,
    });
  } catch (e) {
    console.warn("WebGPU failed, falling back to wasm", e);
    tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm",
    });
  }
  listenBtn.disabled = false;
  listenBtn.textContent = "Start listening";
  speakBtn.disabled = false;
  setStatus("Ready.");
}

// ---------- Playback queue ----------
const queue = [];
let playing = false;

function floatToWavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function playNext() {
  if (playing) return;
  const clip = queue.shift();
  if (!clip) return;
  playing = true;
  const url = URL.createObjectURL(floatToWavBlob(clip, sampleRate));
  const a = new Audio(url);
  if (sinkId && a.setSinkId) {
    try { await a.setSinkId(sinkId); } catch (e) { console.warn("setSinkId failed", e); }
  }
  a.onended = a.onerror = () => {
    URL.revokeObjectURL(url);
    playing = false;
    playNext();
  };
  a.play().catch(() => { playing = false; playNext(); });
}

let genChain = Promise.resolve(); // keeps generated chunks in order
function speak(text) {
  text = text.trim();
  if (!text || !tts) return;
  genChain = genChain.then(async () => {
    try {
      const audio = await tts.generate(text, { voice });
      sampleRate = audio.sampling_rate;
      allClips.push(audio.audio);
      saveBtn.disabled = false;
      queue.push(audio.audio);
      playNext();
    } catch (e) {
      console.error(e);
      setStatus("Voice error: " + e.message);
    }
  });
}

// ---------- Speech recognition (phrase-by-phrase) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function fullTranscript(e) {
  let t = "";
  for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
  return t;
}

function flush(text) {
  const chunk = text.slice(sentLen).trim();
  if (!chunk) return;
  sentLen = text.length;
  speak(chunk);
}

function startRecognition() {
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = "en-US";
  sentLen = 0;
  let latest = "";

  recog.onresult = (e) => {
    latest = fullTranscript(e);
    heard.value = latest;
    clearTimeout(flushTimer);
    const pending = latest.slice(sentLen).trim();
    if (pending.split(/\s+/).length >= MAX_WORDS) {
      flush(latest);
    } else {
      flushTimer = setTimeout(() => flush(latest), PAUSE_MS);
    }
  };
  recog.onerror = (e) => setStatus("Mic/recognition: " + e.error);
  recog.onend = () => {
    clearTimeout(flushTimer);
    flush(latest);
    if (listening) startRecognition(); // Chrome stops after silence; keep going
  };
  recog.start();
}

listenBtn.onclick = async () => {
  if (!SR) return setStatus("Use Google Chrome — this browser has no speech recognition.");
  if (!listening) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await fillDevices();
    } catch (e) {
      return setStatus("Microphone permission needed.");
    }
    listening = true;
    listenBtn.textContent = "Stop listening";
    listenBtn.classList.add("on");
    setStatus("Listening… speak in short phrases with tiny pauses.");
    startRecognition();
  } else {
    listening = false;
    listenBtn.textContent = "Start listening";
    listenBtn.classList.remove("on");
    setStatus("Stopped.");
    recog && recog.stop();
  }
};

// ---------- Controls ----------
speakBtn.onclick = () => speak(heard.value);

saveBtn.onclick = () => {
  const total = allClips.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of allClips) { out.set(c, o); o += c.length; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(floatToWavBlob(out, sampleRate));
  a.download = "voice-clip.wav";
  a.click();
};

voiceBtns.forEach((b) => (b.onclick = () => {
  voice = b.dataset.voice;
  voiceBtns.forEach((x) => x.classList.toggle("active", x === b));
}));

async function fillDevices() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  outSel.innerHTML = "";
  devs.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || "Output " + (outSel.length + 1);
    outSel.appendChild(o);
  });
  if (sinkId) outSel.value = sinkId;
}
outSel.onchange = () => (sinkId = outSel.value);
fillDevices();

loadModel();

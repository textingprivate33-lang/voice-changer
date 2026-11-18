const $ = (id) => document.getElementById(id);

const els = {
  go: $("go"),
  prog: $("prog"),
  status: $("status"),
  interim: $("interim"),
  lag: $("lag"),
  log: $("log"),
  voice: $("voice"),
  lang: $("lang"),
  sink: $("sink"),
  speed: $("speed"),
  speedOut: $("speedOut"),
  pause: $("pause"),
  pauseOut: $("pauseOut"),
  monitor: $("monitor"),
  test: $("test"),
  save: $("save"),
  typed: $("typed"),
  typedForm: $("typedForm"),
};

const VOICES = {
  us: [
    ["af_heart", "Heart (female)"],
    ["af_bella", "Bella (female)"],
    ["am_michael", "Michael (male)"],
    ["am_adam", "Adam (male)"],
  ],
  uk: [
    ["bf_emma", "Emma (female)"],
    ["bf_isabella", "Isabella (female)"],
    ["bm_george", "George (male)"],
    ["bm_lewis", "Lewis (male)"],
  ],
};

// A phrase is sent early once it holds this many unspoken words.
const MAX_WORDS = 7;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let modelState = "idle"; // idle | loading | ready
let listening = false;
let wantListening = false;
let rec = null;
let pauseTimer = null;
let nextId = 1;
let waiting = 0;

const jobs = new Map(); // id -> { li, text }
const spokenCount = new Map(); // recognition result index -> words already sent
const clips = []; // Float32Array chunks, for "Save as audio clip"
let clipRate = 24000;

let ctx = null; // main output (speakers or virtual cable)
let mon = null; // optional second output so you can hear it yourself
const mainClock = { next: 0 };
const monClock = { next: 0 };

/* ---------- small helpers ---------- */

function setStatus(text) {
  els.status.textContent = text;
}

function setLag() {
  els.lag.textContent = waiting > 0 ? `${waiting} phrase${waiting === 1 ? "" : "s"} waiting` : "";
}

function accent() {
  return document.documentElement.dataset.accent;
}

function fillVoices() {
  els.voice.innerHTML = "";
  for (const [id, label] of VOICES[accent()]) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    els.voice.appendChild(opt);
  }
}

function formatPhrase(text, final) {
  let t = text.trim();
  if (!t) return "";
  t = t[0].toUpperCase() + t.slice(1);
  if (!/[.!?,;:]$/.test(t)) t += final ? "." : ",";
  return t;
}

/* ---------- accent + settings ---------- */

for (const btn of document.querySelectorAll(".accent button")) {
  btn.addEventListener("click", () => {
    document.documentElement.dataset.accent = btn.dataset.accent;
    for (const b of document.querySelectorAll(".accent button")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    fillVoices();
  });
}

els.speed.addEventListener("input", () => {
  els.speedOut.textContent = Number(els.speed.value).toFixed(2).replace(/0$/, "");
});
els.pause.addEventListener("input", () => {
  els.pauseOut.textContent = els.pause.value;
});

fillVoices();

/* ---------- text to speech worker ---------- */

const worker = new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
const fileProgress = new Map();

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "progress") {
    const p = msg.p;
    if (p && p.status === "progress" && p.file) {
      fileProgress.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0;
      let total = 0;
      fileProgress.forEach((v) => {
        loaded += v.loaded;
        total += v.total;
      });
      if (total > 0) {
        els.prog.hidden = false;
        els.prog.max = total;
        els.prog.value = loaded;
        setStatus(`Downloading voices: ${Math.round((loaded / total) * 100)}%`);
      }
    }
  } else if (msg.type === "ready") {
    modelState = "ready";
    els.prog.hidden = true;
    els.go.disabled = false;
    els.go.textContent = "Start listening";
    setStatus("Voices are ready. Press Start listening, then speak in short phrases.");
  } else if (msg.type === "audio") {
    waiting = Math.max(0, waiting - 1);
    setLag();
    handleAudio(msg.id, msg.audio, msg.sampleRate);
  } else if (msg.type === "error") {
    if (msg.id && jobs.has(msg.id)) {
      waiting = Math.max(0, waiting - 1);
      setLag();
      jobs.get(msg.id).li.dataset.state = "failed";
    } else {
      modelState = "idle";
      els.go.disabled = false;
      els.go.textContent = "Load voices (about 80 MB, once)";
      els.prog.hidden = true;
    }
    setStatus(`Something went wrong: ${msg.message}`);
  }
};

function loadModel() {
  modelState = "loading";
  els.go.disabled = true;
  els.go.textContent = "Loading voices...";
  setStatus("Starting download...");
  worker.postMessage({ type: "init" });
}

/* ---------- audio output ---------- */

async function ensureMainContext() {
  if (!ctx) {
    ctx = new AudioContext();
    await applySink();
  }
  if (ctx.state === "suspended") await ctx.resume();
}

async function applySink() {
  if (!ctx || typeof ctx.setSinkId !== "function") return;
  try {
    await ctx.setSinkId(els.sink.value || "");
  } catch (err) {
    setStatus(`Could not use that output device: ${err.message}`);
  }
}

async function ensureMonitor() {
  if (!mon) mon = new AudioContext();
  if (mon.state === "suspended") await mon.resume();
}

function schedule(context, clock, buffer) {
  const start = Math.max(context.currentTime + 0.03, clock.next);
  const src = context.createBufferSource();
  src.buffer = buffer;
  src.connect(context.destination);
  src.start(start);
  clock.next = start + buffer.duration + 0.05;
  return { start, end: start + buffer.duration };
}

async function handleAudio(id, samples, sampleRate) {
  clips.push(samples);
  clipRate = sampleRate;
  try {
    await ensureMainContext();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const t = schedule(ctx, mainClock, buffer);

    if (els.monitor.checked) {
      await ensureMonitor();
      const mbuf = mon.createBuffer(1, samples.length, sampleRate);
      mbuf.copyToChannel(samples, 0);
      schedule(mon, monClock, mbuf);
    }

    const job = jobs.get(id);
    if (job) {
      const toStart = Math.max(0, (t.start - ctx.currentTime) * 1000);
      const toEnd = Math.max(0, (t.end - ctx.currentTime) * 1000);
      setTimeout(() => (job.li.dataset.state = "speaking"), toStart);
      setTimeout(() => (job.li.dataset.state = "done"), toEnd);
    }
  } catch (err) {
    setStatus(`Could not play audio: ${err.message}`);
  }
}

els.sink.addEventListener("change", applySink);

async function refreshDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const current = els.sink.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  els.sink.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Default speakers";
  els.sink.appendChild(def);
  for (const d of devices) {
    if (d.kind !== "audiooutput" || d.deviceId === "default" || d.deviceId === "communications") continue;
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || "Output device";
    els.sink.appendChild(opt);
  }
  els.sink.value = [...els.sink.options].some((o) => o.value === current) ? current : "";
}

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
}

/* ---------- sending phrases to the voice ---------- */

function enqueue(text, final) {
  const phrase = formatPhrase(text, final);
  if (!phrase) return;
  if (modelState !== "ready") {
    setStatus("Load the voices first.");
    return;
  }
  const id = nextId++;
  const li = document.createElement("li");
  li.dataset.state = "waiting";
  li.textContent = phrase;
  els.log.appendChild(li);
  while (els.log.children.length > 8) els.log.firstElementChild.remove();
  jobs.set(id, { li, text: phrase });
  waiting += 1;
  setLag();
  worker.postMessage({
    type: "speak",
    id,
    text: phrase,
    voice: els.voice.value,
    speed: Number(els.speed.value),
  });
}

els.typedForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.typed.value;
  els.typed.value = "";
  enqueue(text, true);
});

els.test.addEventListener("click", async () => {
  await ensureMainContext();
  enqueue("Hello. This is a test of the voice.", true);
});

/* ---------- speech recognition ---------- */

function words(text) {
  return text.split(/\s+/).filter(Boolean);
}

function sendUpTo(index, text, upTo, final) {
  const w = words(text);
  const done = spokenCount.get(index) || 0;
  const end = Math.min(upTo, w.length);
  if (end > done) {
    spokenCount.set(index, end);
    enqueue(w.slice(done, end).join(" "), final);
  }
}

function onResult(event) {
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const res = event.results[i];
    const text = res[0].transcript.trim();
    els.interim.textContent = text || els.interim.textContent;

    if (res.isFinal) {
      clearTimeout(pauseTimer);
      sendUpTo(i, text, Infinity, true);
      continue;
    }

    const w = words(text);
    const done = spokenCount.get(i) || 0;
    // Long phrase: send everything except the last two words, which may still change.
    if (w.length - done >= MAX_WORDS) {
      sendUpTo(i, text, w.length - 2, false);
    }
    // Natural pause: send whatever is left.
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => sendUpTo(i, text, Infinity, false), Number(els.pause.value));
  }
}

function startRecognition() {
  rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = els.lang.value;
  rec.onresult = onResult;
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      wantListening = false;
      setStatus("The microphone is blocked. Allow it for this site, then press Start listening again.");
    } else if (e.error === "network") {
      setStatus("Speech recognition needs an internet connection.");
    } else {
      setStatus(`Microphone problem: ${e.error}`);
    }
  };
  rec.onend = () => {
    spokenCount.clear();
    if (wantListening) {
      try {
        startRecognition();
      } catch (err) {
        setTimeout(() => wantListening && startRecognition(), 400);
      }
    } else {
      setListeningUI(false);
    }
  };
  rec.start();
}

function setListeningUI(on) {
  listening = on;
  els.go.classList.toggle("live", on);
  els.go.textContent = on ? "Listening. Press to stop" : "Start listening";
  if (on) setStatus("Listening. Speak in short phrases and pause briefly between them.");
  else if (modelState === "ready") setStatus("Stopped.");
}

async function startListening() {
  if (!SpeechRecognition) {
    setStatus("Speech recognition needs Chrome or Edge on a computer. You can still type lines below.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    setStatus("The microphone is blocked. Allow it for this site, then press Start listening again.");
    return;
  }
  await ensureMainContext();
  await refreshDevices();
  wantListening = true;
  startRecognition();
  setListeningUI(true);
}

function stopListening() {
  wantListening = false;
  clearTimeout(pauseTimer);
  if (rec) rec.stop();
  setListeningUI(false);
}

els.lang.addEventListener("change", () => {
  if (listening) {
    stopListening();
    setStatus("Language changed. Press Start listening again.");
  }
});

els.go.addEventListener("click", async () => {
  if (modelState === "idle") {
    await ensureMainContext(); // unlock audio inside the click
    loadModel();
  } else if (modelState === "ready") {
    if (listening) stopListening();
    else await startListening();
  }
});

/* ---------- save as audio clip ---------- */

function toWav(chunks, sampleRate) {
  const gap = Math.round(sampleRate * 0.15);
  let total = 0;
  chunks.forEach((c, i) => (total += c.length + (i ? gap : 0)));
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  chunks.forEach((c, i) => {
    if (i) offset += gap * 2; // silence between phrases
    for (let n = 0; n < c.length; n++, offset += 2) {
      const s = Math.max(-1, Math.min(1, c[n]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  });
  return new Blob([buffer], { type: "audio/wav" });
}

els.save.addEventListener("click", () => {
  if (!clips.length) {
    setStatus("Nothing to save yet. Speak or type a line first.");
    return;
  }
  const url = URL.createObjectURL(toWav(clips, clipRate));
  const a = document.createElement("a");
  a.href = url;
  a.download = "voice-clip.wav";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  setStatus("Saved voice-clip.wav. Send it as a voice note if you like.");
});

if (!SpeechRecognition) {
  setStatus("Speech recognition needs Chrome or Edge on a computer. You can still load the voices and type lines.");
}

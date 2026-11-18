import { KokoroTTS } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;
let chain = Promise.resolve();

async function handle(msg) {
  try {
    if (msg.type === "init") {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => self.postMessage({ type: "progress", p }),
      });
      self.postMessage({ type: "ready" });
    } else if (msg.type === "speak") {
      const out = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
      const samples = new Float32Array(out.audio);
      self.postMessage(
        { type: "audio", id: msg.id, audio: samples, sampleRate: out.sampling_rate },
        [samples.buffer]
      );
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
}

// Run one job at a time so the model is never used twice at once.
self.onmessage = (e) => {
  chain = chain.then(() => handle(e.data));
};

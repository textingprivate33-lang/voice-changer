# Voice relay

Speak into your microphone and hear your words back in a natural **US or UK** voice.
Everything runs in the browser (Kokoro text to speech), so hosting is free.

## How it works

1. Chrome listens to you and turns your speech into text.
2. Kokoro reads that text in the US or UK voice you pick.
3. The voice plays on your speakers, or into a virtual cable so a call app can use it as a microphone.

The voice trails you by about 1 to 2 seconds. Speak in short phrases and pause briefly between them.

## Use it

1. Open the page in **Chrome or Edge on a computer**.
2. Press **Load voices** (about 80 MB, the first time only).
3. Press **Start listening**, allow the microphone, and speak.

## Use it on a Messenger or Facebook call

1. Install **VB-Cable** from vb-audio.com/Cable and restart Windows.
2. In this page, open Settings and set **Output device** to **CABLE Input**.
3. In Messenger (desktop app or messenger.com), set the **microphone** to **CABLE Output**.
4. Use earphones. Tick "Also let me hear it on my own speakers" if you want to hear the voice yourself.
5. Test with a second account before the real call.

While the cable is the microphone, the other person hears only the voice from this page, not your real voice.

## Run on your computer

```
npm install
npm run dev
```

Then open the address it prints (for example http://localhost:5173) in Chrome.

## Deploy on Vercel (free)

1. Go to vercel.com, choose **Add New, Project**, and import this repository.
2. Leave the settings as they are (Vercel detects Vite). Press **Deploy**.

The microphone needs https, which Vercel provides.

## Notes

- The speech to text step uses Chrome's built-in recognition, which sends audio to Google. If you want it fully private, the recognition step can be swapped for Whisper later.
- Voices are downloaded from Hugging Face on first use and cached by the browser.

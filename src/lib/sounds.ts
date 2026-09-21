// Tiny synthesized WAV data URIs for use-sound. Built once at module load.
// We synthesize short tones with a soft attack/decay envelope so we don't need audio files.

function buildWav(samples: Float32Array, sampleRate = 44100): string {
  const length = samples.length;
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, length * 2, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(binary);
}

type Tone = { freq: number; dur: number; type?: "sine" | "triangle"; gain?: number };

function synth(tones: Tone[], gap = 0): string {
  const sr = 44100;
  const totalDur = tones.reduce((s, t) => s + t.dur, 0) + gap * (tones.length - 1);
  const total = Math.floor(sr * totalDur);
  const out = new Float32Array(total);
  let cursor = 0;
  for (const t of tones) {
    const len = Math.floor(sr * t.dur);
    const g = t.gain ?? 0.25;
    for (let i = 0; i < len; i++) {
      const tt = i / sr;
      const env =
        Math.min(1, tt / 0.012) *
        Math.min(1, (t.dur - tt) / 0.08);
      let v;
      const phase = 2 * Math.PI * t.freq * tt;
      if (t.type === "triangle") {
        v = (2 / Math.PI) * Math.asin(Math.sin(phase));
      } else {
        v = Math.sin(phase);
      }
      out[cursor + i] = v * g * env;
    }
    cursor += len + Math.floor(sr * gap);
  }
  return buildWav(out, sr);
}

// Need: low, solid, grounding (single warm tone)
export const SOUND_NEED = synth([{ freq: 196, dur: 0.32, type: "triangle", gain: 0.28 }]);

// Want: slightly higher, two-note "question" (rising)
export const SOUND_WANT = synth([
  { freq: 392, dur: 0.16, type: "sine", gain: 0.22 },
  { freq: 523, dur: 0.22, type: "sine", gain: 0.2 },
], 0.02);

// Let-it-go: gentle ascending arpeggio flourish
export const SOUND_LETGO = synth([
  { freq: 523, dur: 0.13, type: "sine", gain: 0.22 },
  { freq: 659, dur: 0.13, type: "sine", gain: 0.22 },
  { freq: 784, dur: 0.18, type: "sine", gain: 0.22 },
  { freq: 1047, dur: 0.28, type: "sine", gain: 0.2 },
], 0.01);

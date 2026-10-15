import { pcmFromSamples } from "../dictation/clipAudio.js";

export const encodeWav = (request: { readonly samples: Float32Array; readonly sampleRate: number }): Buffer => {
  const pcm = pcmFromSamples(request.samples);
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + pcm.length * 2, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(request.sampleRate, 24);
  bytes.writeUInt32LE(request.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(pcm.length * 2, 40);
  for (const [index, sample] of pcm.entries()) {
    bytes.writeInt16LE(sample, 44 + index * 2);
  }
  return bytes;
};

type WavChunk = { readonly id: string; readonly start: number; readonly size: number };

const wavChunks = (bytes: Buffer): ReadonlyArray<WavChunk> => {
  const chunks: Array<WavChunk> = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    chunks.push({ id, start: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
  return chunks;
};

// Keeps only the first channel: every reader wants mono.
export const decodeWav = (bytes: Buffer): { readonly sampleRate: number; readonly pcm: Int16Array } | undefined => {
  const isWave = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  if (!isWave) {
    return undefined;
  }

  const chunks = wavChunks(bytes);
  const format = chunks.find((chunk) => chunk.id === "fmt ");
  const samples = chunks.find((chunk) => chunk.id === "data");
  if (format === undefined || samples === undefined || bytes.readUInt16LE(format.start + 14) !== 16) {
    return undefined;
  }

  const channels = bytes.readUInt16LE(format.start + 2);
  const sampleBytes = Math.min(samples.size, bytes.length - samples.start);
  const frameCount = Math.floor(sampleBytes / (2 * channels));
  const pcm = Int16Array.from({ length: frameCount }, (_unused, frame) =>
    bytes.readInt16LE(samples.start + frame * 2 * channels),
  );
  return { sampleRate: bytes.readUInt32LE(format.start + 4), pcm };
};

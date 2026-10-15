/** 16-bit PCM WAV files: written for afplay and whisper fixtures, read back by tests and the bench. */

export const encodeWav = (request: { readonly samples: Float32Array; readonly sampleRate: number }): Buffer => {
  const bytes = Buffer.alloc(44 + request.samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + request.samples.length * 2, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(request.sampleRate, 24);
  bytes.writeUInt32LE(request.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(request.samples.length * 2, 40);
  request.samples.forEach((sample, index) => {
    bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767))), 44 + index * 2);
  });
  return bytes;
};

type WavChunk = { readonly id: string; readonly start: number; readonly size: number };

const wavChunks = (bytes: Buffer): ReadonlyArray<WavChunk> => {
  const chunks: Array<WavChunk> = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    chunks.push({ id: bytes.toString("ascii", offset, offset + 4), start: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
  return chunks;
};

/** Mono 16-bit samples of a PCM WAV (the first channel when there are more), or undefined for another format. */
export const decodeWav = (bytes: Buffer): { readonly sampleRate: number; readonly pcm: Int16Array } | undefined => {
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }

  const chunks = wavChunks(bytes);
  const format = chunks.find((chunk) => chunk.id === "fmt ");
  const samples = chunks.find((chunk) => chunk.id === "data");
  if (format === undefined || samples === undefined || bytes.readUInt16LE(format.start + 14) !== 16) {
    return undefined;
  }

  const channels = bytes.readUInt16LE(format.start + 2);
  const frameCount = Math.floor(Math.min(samples.size, bytes.length - samples.start) / (2 * channels));
  return {
    sampleRate: bytes.readUInt32LE(format.start + 4),
    pcm: Int16Array.from({ length: frameCount }, (_unused, frame) =>
      bytes.readInt16LE(samples.start + frame * 2 * channels),
    ),
  };
};

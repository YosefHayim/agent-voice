import { readPcmFromSamples } from "#src/dictation/clip-audio.js";

const ASCII_ENCODING = "ascii";
const RIFF_TAG = "RIFF";
const WAVE_TAG = "WAVE";
const FORMAT_CHUNK_TAG = "fmt ";
const SAMPLES_CHUNK_TAG = "data";
const TAG_BYTES = 4;
const CHUNK_SIZE_OFFSET = 4;
const CHUNK_HEADER_BYTES = 8;
const RIFF_HEADER_BYTES = 12;
const WAVE_TAG_OFFSET = 8;
const BYTES_PER_SAMPLE = 2;
const BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;

export const encodeWav = (request: { readonly samples: Float32Array; readonly sampleRate: number }): Buffer => {
  const pcm = readPcmFromSamples(request.samples);
  const pcmBytes = pcm.length * BYTES_PER_SAMPLE;
  const bytes = Buffer.alloc(WAV_HEADER_BYTES + pcmBytes);

  const riffSizeWithoutPcmBytes = 36;
  bytes.write(RIFF_TAG, 0, ASCII_ENCODING);
  bytes.writeUInt32LE(riffSizeWithoutPcmBytes + pcmBytes, CHUNK_SIZE_OFFSET);
  bytes.write(WAVE_TAG + FORMAT_CHUNK_TAG, WAVE_TAG_OFFSET, ASCII_ENCODING);

  const formatChunkBytes = 16;
  const formatChunkSizeOffset = 16;
  bytes.writeUInt32LE(formatChunkBytes, formatChunkSizeOffset);

  const pcmFormatCode = 1;
  const formatCodeOffset = 20;
  bytes.writeUInt16LE(pcmFormatCode, formatCodeOffset);

  const monoChannelCount = 1;
  const formatChannelsOffset = 22;
  bytes.writeUInt16LE(monoChannelCount, formatChannelsOffset);

  const formatSampleRateOffset = 24;
  bytes.writeUInt32LE(request.sampleRate, formatSampleRateOffset);

  const formatByteRateOffset = 28;
  bytes.writeUInt32LE(request.sampleRate * BYTES_PER_SAMPLE, formatByteRateOffset);

  const formatBlockAlignOffset = 32;
  bytes.writeUInt16LE(BYTES_PER_SAMPLE, formatBlockAlignOffset);

  const formatBitsOffset = 34;
  bytes.writeUInt16LE(BITS_PER_SAMPLE, formatBitsOffset);

  const samplesChunkTagOffset = 36;
  bytes.write(SAMPLES_CHUNK_TAG, samplesChunkTagOffset, ASCII_ENCODING);

  const samplesChunkSizeOffset = 40;
  bytes.writeUInt32LE(pcmBytes, samplesChunkSizeOffset);

  for (const [index, sample] of pcm.entries()) {
    bytes.writeInt16LE(sample, WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE);
  }
  return bytes;
};

type WavChunk = { readonly id: string; readonly start: number; readonly size: number };

const listWavChunks = (bytes: Buffer): ReadonlyArray<WavChunk> => {
  const chunks: Array<WavChunk> = [];
  let offset = RIFF_HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    const id = bytes.toString(ASCII_ENCODING, offset, offset + TAG_BYTES);
    const size = bytes.readUInt32LE(offset + CHUNK_SIZE_OFFSET);
    chunks.push({ id, start: offset + CHUNK_HEADER_BYTES, size });

    const chunkPaddingAlignment = 2;
    offset += CHUNK_HEADER_BYTES + size + (size % chunkPaddingAlignment);
  }
  return chunks;
};

// Keeps only the first channel: every reader wants mono.
export const decodeWav = (bytes: Buffer): { readonly sampleRate: number; readonly pcm: Int16Array } | null => {
  const isNotWave =
    bytes.toString(ASCII_ENCODING, 0, TAG_BYTES) !== RIFF_TAG ||
    bytes.toString(ASCII_ENCODING, WAVE_TAG_OFFSET, RIFF_HEADER_BYTES) !== WAVE_TAG;
  if (isNotWave) {
    return null;
  }

  const chunks = listWavChunks(bytes);
  const format = chunks.find((chunk) => chunk.id === FORMAT_CHUNK_TAG);

  const samples = chunks.find((chunk) => chunk.id === SAMPLES_CHUNK_TAG);

  const formatChunkBitsOffset = 14;
  const isUnsupportedWave =
    format == null || samples == null || bytes.readUInt16LE(format.start + formatChunkBitsOffset) !== BITS_PER_SAMPLE;
  if (isUnsupportedWave) {
    return null;
  }

  const formatChunkChannelsOffset = 2;
  const channels = bytes.readUInt16LE(format.start + formatChunkChannelsOffset);
  const sampleBytes = Math.min(samples.size, bytes.length - samples.start);
  const frameCount = Math.floor(sampleBytes / (BYTES_PER_SAMPLE * channels));
  const pcm = Int16Array.from({ length: frameCount }, (_unused, frame) =>
    bytes.readInt16LE(samples.start + frame * BYTES_PER_SAMPLE * channels),
  );

  const formatChunkSampleRateOffset = 4;
  return { sampleRate: bytes.readUInt32LE(format.start + formatChunkSampleRateOffset), pcm };
};

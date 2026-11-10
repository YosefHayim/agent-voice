import { readPcmFromSamples } from "#src/dictation/clip-audio.js";

const ASCII_ENCODING = "ascii";
const RIFF_TAG = "RIFF";
const WAVE_TAG = "WAVE";
const FORMAT_CHUNK_TAG = "fmt ";
const DATA_CHUNK_TAG = "data";
const TAG_BYTES = 4;
const CHUNK_SIZE_OFFSET = 4;
const CHUNK_HEADER_BYTES = 8;
const RIFF_HEADER_BYTES = 12;
const WAVE_TAG_OFFSET = 8;
const CHUNK_PADDING_ALIGNMENT = 2;
const BYTES_PER_SAMPLE = 2;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT_CODE = 1;
const MONO_CHANNEL_COUNT = 1;
const FORMAT_CHUNK_BYTES = 16;
const WAV_HEADER_BYTES = 44;
const RIFF_SIZE_WITHOUT_PCM_BYTES = 36;
const FORMAT_CHUNK_SIZE_OFFSET = 16;
const FORMAT_CODE_OFFSET = 20;
const FORMAT_CHANNELS_OFFSET = 22;
const FORMAT_SAMPLE_RATE_OFFSET = 24;
const FORMAT_BYTE_RATE_OFFSET = 28;
const FORMAT_BLOCK_ALIGN_OFFSET = 32;
const FORMAT_BITS_OFFSET = 34;
const DATA_CHUNK_TAG_OFFSET = 36;
const DATA_CHUNK_SIZE_OFFSET = 40;
const FORMAT_BODY_CHANNELS_OFFSET = 2;
const FORMAT_BODY_SAMPLE_RATE_OFFSET = 4;
const FORMAT_BODY_BITS_OFFSET = 14;

export const encodeWav = (request: { readonly samples: Float32Array; readonly sampleRate: number }): Buffer => {
  const pcm = readPcmFromSamples(request.samples);
  const pcmBytes = pcm.length * BYTES_PER_SAMPLE;
  const bytes = Buffer.alloc(WAV_HEADER_BYTES + pcmBytes);
  bytes.write(RIFF_TAG, 0, ASCII_ENCODING);
  bytes.writeUInt32LE(RIFF_SIZE_WITHOUT_PCM_BYTES + pcmBytes, CHUNK_SIZE_OFFSET);
  bytes.write(WAVE_TAG + FORMAT_CHUNK_TAG, WAVE_TAG_OFFSET, ASCII_ENCODING);
  bytes.writeUInt32LE(FORMAT_CHUNK_BYTES, FORMAT_CHUNK_SIZE_OFFSET);
  bytes.writeUInt16LE(PCM_FORMAT_CODE, FORMAT_CODE_OFFSET);
  bytes.writeUInt16LE(MONO_CHANNEL_COUNT, FORMAT_CHANNELS_OFFSET);
  bytes.writeUInt32LE(request.sampleRate, FORMAT_SAMPLE_RATE_OFFSET);
  bytes.writeUInt32LE(request.sampleRate * BYTES_PER_SAMPLE, FORMAT_BYTE_RATE_OFFSET);
  bytes.writeUInt16LE(BYTES_PER_SAMPLE, FORMAT_BLOCK_ALIGN_OFFSET);
  bytes.writeUInt16LE(BITS_PER_SAMPLE, FORMAT_BITS_OFFSET);
  bytes.write(DATA_CHUNK_TAG, DATA_CHUNK_TAG_OFFSET, ASCII_ENCODING);
  bytes.writeUInt32LE(pcmBytes, DATA_CHUNK_SIZE_OFFSET);
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
    offset += CHUNK_HEADER_BYTES + size + (size % CHUNK_PADDING_ALIGNMENT);
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

  const samples = chunks.find((chunk) => chunk.id === DATA_CHUNK_TAG);

  const isUnsupportedWave =
    format == null || samples == null || bytes.readUInt16LE(format.start + FORMAT_BODY_BITS_OFFSET) !== BITS_PER_SAMPLE;
  if (isUnsupportedWave) {
    return null;
  }

  const channels = bytes.readUInt16LE(format.start + FORMAT_BODY_CHANNELS_OFFSET);
  const sampleBytes = Math.min(samples.size, bytes.length - samples.start);
  const frameCount = Math.floor(sampleBytes / (BYTES_PER_SAMPLE * channels));
  const pcm = Int16Array.from({ length: frameCount }, (_unused, frame) =>
    bytes.readInt16LE(samples.start + frame * BYTES_PER_SAMPLE * channels),
  );
  return { sampleRate: bytes.readUInt32LE(format.start + FORMAT_BODY_SAMPLE_RATE_OFFSET), pcm };
};

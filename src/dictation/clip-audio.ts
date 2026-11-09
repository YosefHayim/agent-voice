export const SAMPLE_RATE = 16_000;

// Below this loudness after normalizing, the whole clip is silence.
const SILENCE_RMS = 0.003;
// One energy frame, about 30 ms.
const VAD_FRAME = 480;
// Whisper needs about 120 ms of voiced audio before its text can be trusted.
export const MIN_VOICED_SAMPLES = 1_920;
// Context kept around the voiced region, about 150 ms.
const SPEECH_PAD_FRAMES = 5;
// A long clip with fewer voiced frames than this is noise, like a bus or wind.
const MIN_VOICED_FRAME_RATIO = 0.04;
export const NORMALIZE_PEAK = 0.45;
// Caps the gain so digital silence cannot be lifted into loud noise.
const MAX_NORMALIZE_GAIN = 50;
const TURN = 2 * Math.PI;

export const rootMeanSquare = (samples: Float32Array): number => {
  if (samples.length === 0) {
    return 0;
  }

  const sumOfSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(sumOfSquares / samples.length);
};

export const peakOf = (samples: Float32Array): number =>
  samples.reduce((peak, sample) => {
    const loudness = Math.abs(sample);
    return Math.max(peak, loudness);
  }, 0);

export const samplesFromPcm = (pcm: Int16Array): Float32Array => Float32Array.from(pcm, (sample) => sample / 32_768);

const pcmSample = (sample: number): number => {
  const scaled = Math.round(sample * 32_767);
  const belowCeiling = Math.min(32_767, scaled);
  return Math.max(-32_768, belowCeiling);
};

export const pcmFromSamples = (samples: Float32Array): Int16Array => Int16Array.from(samples, pcmSample);

export const peakNormalize = (samples: Float32Array, targetPeak: number): Float32Array => {
  const peak = peakOf(samples);
  if (peak < 1e-6) {
    return samples;
  }

  const wantedGain = Math.max(targetPeak / peak, 1);
  const gain = Math.min(wantedGain, MAX_NORMALIZE_GAIN);
  const isGainNearOne = Math.abs(gain - 1) < 0.05;
  if (isGainNearOne) {
    return samples;
  }

  return samples.map((sample) => sample * gain);
};

const frameEnergies = (samples: Float32Array): ReadonlyArray<number> => {
  const frameCount = Math.floor(samples.length / VAD_FRAME);
  return Array.from({ length: frameCount }, (_unused, frame) => {
    const frameSamples = samples.subarray(frame * VAD_FRAME, (frame + 1) * VAD_FRAME);
    return rootMeanSquare(frameSamples);
  });
};

// Softer than median x 2.2 so continuous soft speech still marks most frames voiced; the floor stays above silence.
const voicedThreshold = (energies: ReadonlyArray<number>): number => {
  const sorted = [...energies].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  const ninetiethIndex = Math.floor((sorted.length * 9) / 10);
  const median = sorted[medianIndex] || 0;
  const ninetieth = sorted[ninetiethIndex] || 0;
  const softFloor = Math.max(median * 1.6, SILENCE_RMS * 1.2);
  const loudPeak = Math.max(ninetieth, SILENCE_RMS);
  return Math.min(softFloor, loudPeak * 0.9);
};

const keepIfLoud = (samples: Float32Array, minimumRms: number): Float32Array | undefined => {
  const isLoud = rootMeanSquare(samples) >= minimumRms;
  if (!isLoud) {
    return undefined;
  }

  return samples;
};

export const extractSpeechRegion = (samples: Float32Array): Float32Array | undefined => {
  if (samples.length < VAD_FRAME) {
    return keepIfLoud(samples, SILENCE_RMS);
  }

  const energies = frameEnergies(samples);
  const threshold = voicedThreshold(energies);
  const voiced = energies.map((energy) => energy >= threshold);
  const voicedCount = voiced.filter(Boolean).length;
  // The adaptive threshold can wipe soft continuous speech; keep the whole clip when it is clearly not silence.
  if (voicedCount === 0) {
    return keepIfLoud(samples, SILENCE_RMS * 1.5);
  }

  // Only a long, noise-heavy clip is dropped; a short hold keeps any voiced span.
  const isMostlyNoise = voicedCount / voiced.length < MIN_VOICED_FRAME_RATIO && samples.length > SAMPLE_RATE * 2;
  if (isMostlyNoise) {
    return keepIfLoud(samples, SILENCE_RMS * 2);
  }

  const firstVoiced = voiced.indexOf(true);
  const lastVoiced = voiced.lastIndexOf(true);
  const startFrame = Math.max(firstVoiced - SPEECH_PAD_FRAMES, 0);
  const endFrame = Math.min(lastVoiced + 1 + SPEECH_PAD_FRAMES, voiced.length);
  const region = samples.subarray(startFrame * VAD_FRAME, endFrame * VAD_FRAME);
  return keepIfLoud(region, SILENCE_RMS);
};

export const prepareForWhisper = (samples: Float32Array): Float32Array | undefined => {
  const normalized = peakNormalize(samples, NORMALIZE_PEAK);
  const isSilence = rootMeanSquare(normalized) < SILENCE_RMS;
  if (isSilence) {
    return undefined;
  }

  const region = extractSpeechRegion(normalized);
  const isLongEnough = region !== undefined && region.length >= MIN_VOICED_SAMPLES;
  if (!isLongEnough) {
    return undefined;
  }

  return region;
};

const speechSample = (index: number): number => {
  const time = index / SAMPLE_RATE;
  const syllable = Math.sin(time * 5 * TURN);
  const envelope = 0.08 + 0.12 * (0.5 + 0.5 * syllable);
  const low = Math.sin(time * 180 * TURN);
  const middle = Math.sin(time * 340 * TURN);
  const high = Math.sin(time * 720 * TURN);
  return envelope * (low + 0.45 * middle + 0.2 * high);
};

// A 5 Hz syllable envelope over three tones, so the voice detector keeps it during warm-up and the bench.
export const syntheticSpeech = (seconds: number): Float32Array => {
  const requestedLength = Math.round(seconds * SAMPLE_RATE);
  const length = Math.max(requestedLength, SAMPLE_RATE / 4);
  return Float32Array.from({ length }, (_unused, index) => speechSample(index));
};

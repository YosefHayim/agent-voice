const HALF = 0.5;

const MAX_INT16 = 32_767;
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

export const readRootMeanSquare = (samples: Float32Array): number => {
  const isSamplesEmpty = samples.length === 0;
  if (isSamplesEmpty) {
    return 0;
  }

  const sumOfSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);
  return Math.sqrt(sumOfSquares / samples.length);
};

export const readPeak = (samples: Float32Array): number =>
  samples.reduce((peak, sample) => {
    const loudness = Math.abs(sample);
    return Math.max(peak, loudness);
  }, 0);

const int16Range = 32_768;

export const readSamplesFromPcm = (pcm: Int16Array): Float32Array =>
  Float32Array.from(pcm, (sample) => sample / int16Range);

const readPcmSample = (sample: number): number => {
  const scaled = Math.round(sample * MAX_INT16);
  const belowCeiling = Math.min(MAX_INT16, scaled);
  const minimumInt16 = -32_768;

  return Math.max(minimumInt16, belowCeiling);
};

export const readPcmFromSamples = (samples: Float32Array): Int16Array => Int16Array.from(samples, readPcmSample);

export const scaleSamplesToPeak = (samples: Float32Array, targetPeak: number): Float32Array => {
  const peak = readPeak(samples);

  const silentPeakLimit = 1e-6;
  const isPeakSilent = peak < silentPeakLimit;
  if (isPeakSilent) {
    return samples;
  }

  const wantedGain = Math.max(targetPeak / peak, 1);
  const gain = Math.min(wantedGain, MAX_NORMALIZE_GAIN);

  const gainNearOneTolerance = 0.05;

  const isGainNearOne = Math.abs(gain - 1) < gainNearOneTolerance;
  if (isGainNearOne) {
    return samples;
  }

  return samples.map((sample) => sample * gain);
};

const listFrameEnergies = (samples: Float32Array): ReadonlyArray<number> => {
  const frameCount = Math.floor(samples.length / VAD_FRAME);
  return Array.from({ length: frameCount }, (_unused, frame) => {
    const frameSamples = samples.subarray(frame * VAD_FRAME, (frame + 1) * VAD_FRAME);
    return readRootMeanSquare(frameSamples);
  });
};

// Softer than median x 2.2 so continuous soft speech still marks most frames voiced; the floor stays above silence.
const readVoicedThreshold = (energies: ReadonlyArray<number>): number => {
  const sorted = [...energies].sort((left, right) => left - right);
  const medianDivisor = 2;

  const medianIndex = Math.floor(sorted.length / medianDivisor);
  const ninetiethDenominator = 10;

  const ninetiethNumerator = 9;

  const ninetiethIndex = Math.floor((sorted.length * ninetiethNumerator) / ninetiethDenominator);
  const median = sorted[medianIndex] || 0;
  const ninetieth = sorted[ninetiethIndex] || 0;
  const softFloorSilenceFactor = 1.2;

  const softFloorMedianFactor = 1.6;

  const softFloor = Math.max(median * softFloorMedianFactor, SILENCE_RMS * softFloorSilenceFactor);
  const loudPeak = Math.max(ninetieth, SILENCE_RMS);
  const loudPeakFactor = 0.9;

  return Math.min(softFloor, loudPeak * loudPeakFactor);
};

const keepIfLoud = (samples: Float32Array, minimumRms: number): Float32Array | null => {
  const isNotLoud = readRootMeanSquare(samples) < minimumRms;
  if (isNotLoud) {
    return null;
  }

  return samples;
};

export const extractSpeechRegion = (samples: Float32Array): Float32Array | null => {
  const isShorterThanVadFrame = samples.length < VAD_FRAME;
  if (isShorterThanVadFrame) {
    return keepIfLoud(samples, SILENCE_RMS);
  }

  const energies = listFrameEnergies(samples);
  const threshold = readVoicedThreshold(energies);
  const voiced = energies.map((energy) => energy >= threshold);

  const voicedCount = voiced.filter(Boolean).length;

  // The adaptive threshold can wipe soft continuous speech; keep the whole clip when it is clearly not silence.
  const hasNoVoicedFrames = voicedCount === 0;
  if (hasNoVoicedFrames) {
    const silenceRmsKeepFactor = 1.5;

    return keepIfLoud(samples, SILENCE_RMS * silenceRmsKeepFactor);
  }

  // Only a long, noise-heavy clip is dropped; a short hold keeps any voiced span.
  const longClipSeconds = 2;

  const isMostlyNoise =
    voicedCount / voiced.length < MIN_VOICED_FRAME_RATIO && samples.length > SAMPLE_RATE * longClipSeconds;
  if (isMostlyNoise) {
    const silenceRmsDoubleFactor = 2;

    return keepIfLoud(samples, SILENCE_RMS * silenceRmsDoubleFactor);
  }

  const firstVoiced = voiced.indexOf(true);
  const lastVoiced = voiced.lastIndexOf(true);
  const startFrame = Math.max(firstVoiced - SPEECH_PAD_FRAMES, 0);
  const endFrame = Math.min(lastVoiced + 1 + SPEECH_PAD_FRAMES, voiced.length);
  const region = samples.subarray(startFrame * VAD_FRAME, endFrame * VAD_FRAME);
  return keepIfLoud(region, SILENCE_RMS);
};

export const prepareForWhisper = (samples: Float32Array): Float32Array | null => {
  const normalized = scaleSamplesToPeak(samples, NORMALIZE_PEAK);

  const isSilence = readRootMeanSquare(normalized) < SILENCE_RMS;
  if (isSilence) {
    return null;
  }

  const region = extractSpeechRegion(normalized);

  const isNotLongEnough = region == null || region.length < MIN_VOICED_SAMPLES;
  if (isNotLongEnough) {
    return null;
  }

  return region;
};

const readSpeechSample = (index: number): number => {
  const time = index / SAMPLE_RATE;
  const syllableRate = 5;

  const syllable = Math.sin(time * syllableRate * TURN);
  const envelopeDepth = 0.12;

  const envelopeFloor = 0.08;

  const envelope = envelopeFloor + envelopeDepth * (HALF + HALF * syllable);
  const lowToneHertz = 180;

  const low = Math.sin(time * lowToneHertz * TURN);
  const middleToneHertz = 340;

  const middle = Math.sin(time * middleToneHertz * TURN);
  const highToneHertz = 720;

  const high = Math.sin(time * highToneHertz * TURN);
  const highToneWeight = 0.2;

  const middleToneWeight = 0.45;

  return envelope * (low + middleToneWeight * middle + highToneWeight * high);
};

// A 5 Hz syllable envelope over three tones, so the voice detector keeps it during warm-up and the bench.
export const readSyntheticSpeech = (seconds: number): Float32Array => {
  const requestedLength = Math.round(seconds * SAMPLE_RATE);
  const quarterSecondDivisor = 4;

  const length = Math.max(requestedLength, SAMPLE_RATE / quarterSecondDivisor);
  return Float32Array.from({ length }, (_unused, index) => readSpeechSample(index));
};

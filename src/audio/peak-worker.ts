/**
 * Web Worker — off-thread waveform peak extraction.
 * Keeps the main thread free during decode-heavy operations.
 */

function extractPeaks(data: Float32Array, count: number): number[] {
  const blockSize = Math.max(1, Math.floor(data.length / count));
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    let max = 0;
    const end = Math.min((i + 1) * blockSize, data.length);
    for (let j = i * blockSize; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

self.onmessage = (e: MessageEvent) => {
  const { id, ch0, ch1, count } = e.data as {
    id: number;
    ch0: Float32Array;
    ch1: Float32Array | null;
    count: number;
  };

  const left  = extractPeaks(ch0, count);
  const right = ch1 ? extractPeaks(ch1, count) : null;

  self.postMessage({ id, left, right });
};

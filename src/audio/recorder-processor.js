/**
 * AudioWorklet processor — runs on the audio rendering thread.
 * Accumulates raw PCM into 4096-sample blocks, then posts to the main thread.
 * Ensures lossless 24-bit capture with minimal IPC overhead.
 */

const BLOCK_SIZE = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffers = [];
    this._offset  = 0;
    this._active  = true;

    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return this._active;

    const numChannels = input.length;
    const numSamples  = input[0].length;

    // Flush partial buffer and stop when asked
    if (!this._active) {
      if (this._buffers.length > 0 && this._offset > 0) {
        const channels = this._buffers.map(buf => buf.slice(0, this._offset));
        this.port.postMessage({ channels, final: true });
      }
      return false;
    }

    // Initialise per-channel accumulation buffers on first call or channel change
    if (this._buffers.length !== numChannels) {
      this._buffers = Array.from({ length: numChannels }, () => new Float32Array(BLOCK_SIZE));
      this._offset  = 0;
    }

    let inputPos = 0;
    while (inputPos < numSamples) {
      const toFill = Math.min(BLOCK_SIZE - this._offset, numSamples - inputPos);
      for (let ch = 0; ch < numChannels; ch++) {
        this._buffers[ch].set(input[ch].subarray(inputPos, inputPos + toFill), this._offset);
      }
      this._offset += toFill;
      inputPos     += toFill;

      if (this._offset >= BLOCK_SIZE) {
        const channels = this._buffers.map(buf => buf.slice()); // copy before next write
        this.port.postMessage({ channels }, channels.map(c => c.buffer));
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);

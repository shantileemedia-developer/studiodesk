/** Global type for the native audio engine bridge exposed by electron/preload.ts */

export interface AudioHostAPI {
  id:   number;
  name: string;
  type: string;
}

export interface AudioDevice {
  id:                number;
  name:              string;
  maxInputChannels:  number;
  maxOutputChannels: number;
  defaultSampleRate: number;
  isDefaultInput:    boolean;
  isDefaultOutput:   boolean;
  hostApi:           string; // 'ASIO' | 'WASAPI' | 'CoreAudio' | 'MME' | 'ALSA' | ...
}

export interface NativeTrackSpec {
  trackId:     string;
  filePath:    string;
  startTime:   number;
  audioOffset: number;
  duration:    number;
  volume:      number;
  pan:         number;
  muted:       boolean;
  fadeIn?:     number;
  fadeOut?:    number;
}

export interface AudioEngineAPI {
  isAvailable():   Promise<boolean>;
  getDevices():    Promise<AudioDevice[]>;
  getHostAPIs():   Promise<{ HostAPIs: AudioHostAPI[] }>;

  play(specs: NativeTrackSpec[], startTime: number, outDeviceId?: number, sr?: number): Promise<void>;
  stop():          Promise<void>;
  seek(t: number): Promise<void>;
  setTrackParams(trackId: string, params: { volume?: number; pan?: number; muted?: boolean }): Promise<void>;

  getTakePath(name: string): Promise<string>;
  startRecording(filePath: string, inId?: number, outId?: number, sr?: number, numCh?: number): Promise<void>;
  stopRecording(): Promise<{ filePath: string; duration: number } | null>;

  startMonitoring(inId?: number, outId?: number, sr?: number, numCh?: number): Promise<void>;
  stopMonitoring(): Promise<void>;

  writeTemp(name: string, data: ArrayBuffer): Promise<string>;

  // Audio Bus API — subscribe to named buses exposed by the DAW engine
  subscribeBus(busId: string):   Promise<void>;
  unsubscribeBus(busId: string): Promise<void>;
  onBusChunk(cb: (busId: string, data: Uint8Array) => void): () => void;

  onPosition(cb: (t: number) => void):   () => void;
  onLevels(cb: (l: number[]) => void):   () => void;
  onInputLevels(cb: (l: number[]) => void): () => void;
  onTrackLevels(cb: (levels: Record<string, [number, number]>) => void): () => void;
  onEnded(cb: (t: number) => void):      () => void;
  onError(cb: (m: string) => void):      () => void;
  onUnavailable(cb: () => void):         () => void;
}

declare global {
  interface Window {
    audioEngine?: AudioEngineAPI;
  }
}

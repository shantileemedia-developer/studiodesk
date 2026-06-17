import React, { createContext, useContext, useReducer, useRef, useCallback } from 'react';

export interface MeterValue {
  L: number;       // instantaneous peak dBFS, floor = -90
  R: number;
  peakL: number;   // held peak dBFS
  peakR: number;
  peakLAt: number; // performance.now() when peak hold expires
  peakRAt: number;
  clipL: boolean;  // latched: set when L >= 0 dBFS, cleared by clearMeterClip()
  clipR: boolean;
}

const TRACK_DEFAULT_COLORS = ['#808080'];

export interface TrackVersion {
  id: string;
  name: string;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  type: 'mono' | 'stereo';
  isMuted: boolean;
  isSolo: boolean;
  isArmed: boolean;
  isMonitoring: boolean;
  volume: number;
  pan: number;
  height?: number;
  versions: TrackVersion[];
  activeVersionId: string;
  inputDeviceId?: string;  // 'default' or a MediaDeviceInfo.deviceId; undefined = use global pref
  groupId?: number | null;  // 1-8, null/undefined = no group
  // Folder track hierarchy: null = top-level, non-null = child of that track id
  parentId?: string | null;
  // Hidden tracks are excluded from the arrange view (collapsed folder, disabled track, etc.)
  isHidden?: boolean;
}

export interface Region {
  id: string;
  poolItemId?: string;      // stable reference to the source PoolItem (used by UPDATE_AUDIO_URLS)
  trackId: string;
  versionId: string;
  startTime: number;        // timelineStart
  duration: number;         // timelineLength (visible clip length in timeline)
  name: string;
  audioUrl: string;         // URL to the source audio file
  localFilePath?: string;   // absolute OS path — used by the native audio engine
  waveformPeaks: number[];
  waveformPeaksR?: number[] | null;
  audioOffset?: number;     // sourceOffset: seconds into the source file where the clip window starts
  sourceDuration?: number;  // sourceLength: total duration of the source audio file (caps edge extension)
  isMuted?: boolean;
  fadeIn?: number;          // fade-in duration in seconds
  fadeOut?: number;         // fade-out duration in seconds
  color?: string;           // per-clip color override (falls back to track color)
  gain?: number;            // per-clip gain multiplier (1.0 = unity, 0–2 range)
  sourcePeaks?: number[];   // full-source waveform peaks — enables correct display after trim/slip
  sourcePeaksR?: number[] | null;
}

export interface PoolItem {
  id: string;
  name: string;
  audioUrl: string;
  localFileName?: string; // filename inside the project's Audio/ subfolder
  storagePath?: string;   // path inside Supabase Storage bucket (used for retry)
  duration: number;
  createdAt: Date;
  waveformPeaks: number[];
  waveformPeaksR?: number[] | null;
  isArchive?: boolean; // true for ZIP export packages
  uploadStatus?: 'uploading' | 'done' | 'failed';
}

export interface DawState {
  projectName: string;
  projectLength: number;
  tracks: Track[];
  regions: Region[];
  poolItems: PoolItem[];
  markers: { id: string; time: number; name: string }[];
  crossfades: Array<{ id: string; regionA: string; regionB: string }>;
  history: {
    past: Pick<DawState, 'tracks' | 'regions' | 'poolItems'>[];
    future: Pick<DawState, 'tracks' | 'regions' | 'poolItems'>[];
  };
  activeTool: ActiveTool;
  selectedTrackId: string | null;
  selectedRegionId: string | null;
  selectedRegionIds: string[];
  snapOn: boolean;
  snapValue: string;
  transport: {
    isPlaying: boolean;
    isRecording: boolean;
    currentTime: number;
    tempo: number;
    timeSignature: [number, number];
    isLooping: boolean;
    loopStart: number;
    loopEnd: number;
    punchIn: number | null;
    punchOut: number | null;
    metronomeOn: boolean;
    countInBars: number;
  };
  trackZoom: number;
  uiDensity: 'compact' | 'standard' | 'large';
  panelSizes: {
    inspectorWidth: number;
    trackListWidth: number;
    mixerHeight: number;
  };
  panelVisibility: {
    inspector: boolean;
    mixer: boolean;
    mediaPool: boolean;
  };
}

export type ActiveTool = 'select' | 'range' | 'draw' | 'erase' | 'split' | 'render' | 'mute' | 'zoom';

export type DawBaseAction =
  | { type: 'SET_PLAYING'; payload: boolean }
  | { type: 'SET_RECORDING'; payload: boolean }
  | { type: 'SET_CURRENT_TIME'; payload: number }
  | { type: 'SET_TEMPO'; payload: number }
  | { type: 'SET_TIME_SIGNATURE'; payload: [number, number] }
  | { type: 'TOGGLE_LOOP' }
  | { type: 'SET_TOOL'; payload: ActiveTool }
  | { type: 'SELECT_TRACK'; payload: string | null }
  | { type: 'SELECT_REGION'; payload: string | null }
  | { type: 'SELECT_REGIONS'; payload: string[] }
  | { type: 'ADD_TRACK'; payload?: { trackType?: 'mono' | 'stereo' } }
  | { type: 'DUPLICATE_TRACK'; payload: string }
  | { type: 'REORDER_TRACKS'; payload: Track[] }
  | { type: 'UPDATE_TRACK'; payload: { id: string; updates: Partial<Track> } }
  | { type: 'RENAME_TRACK'; payload: { id: string; name: string } }
  | { type: 'REMOVE_TRACK'; payload: string }
  | { type: 'ADD_VERSION'; payload: { trackId: string } }
  | { type: 'SWITCH_VERSION'; payload: { trackId: string; versionId: string } }
  | { type: 'ADD_REGION'; payload: Region }
  | { type: 'REMOVE_REGION'; payload: string }
  | { type: 'MOVE_REGION'; payload: { regionId: string; startTime?: number; trackId?: string } }
  | { type: 'UPDATE_REGION'; payload: { id: string; updates: Partial<Region> } }
  | { type: 'RENAME_REGION'; payload: { id: string; name: string } }
  | { type: 'ADD_TRACK_AND_MOVE_REGION'; payload: { regionId: string; trackType?: 'mono' | 'stereo' } }
  | { type: 'BOUNCE_REGIONS'; payload: { regionIds: string[]; newRegion: Region; newPoolItem: PoolItem } }
  | { type: 'SPLIT_REGION'; payload: { regionId: string; splitTime: number } }
  | { type: 'TOGGLE_REGION_MUTE'; payload: string }
  | { type: 'RENDER_REGIONS'; payload: string }
  | { type: 'TRIM_REGION'; payload: { regionId: string; startTime: number; duration: number; audioOffset: number } }
  | { type: 'SET_PROJECT_LENGTH'; payload: number }
  | { type: 'SET_SNAP'; payload: { on: boolean; value: string } }
  | { type: 'ADD_CROSSFADE'; payload: { regionA: string; regionB: string } }
  | { type: 'REMOVE_CROSSFADE'; payload: string }
  | { type: 'ADD_POOL_ITEM'; payload: PoolItem }
  | { type: 'REMOVE_POOL_ITEM'; payload: string }
  | { type: 'UPDATE_AUDIO_URLS'; payload: { poolItemId: string; audioUrl: string } }
  | { type: 'RENAME_VERSION'; payload: { trackId: string; versionId: string; name: string } }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'RESIZE_TRACK'; payload: { id: string; height: number } }
  | { type: 'SET_LOOP_RANGE'; payload: { start: number; end: number } }
  | { type: 'SET_PUNCH_RANGE'; payload: { start: number | null; end: number | null } }
  | { type: 'TOGGLE_METRONOME' }
  | { type: 'SET_COUNT_IN'; payload: number }
  | { type: 'ADD_MARKER'; payload: { id: string; time: number; name: string } }
  | { type: 'REMOVE_MARKER'; payload: string }
  | { type: 'RENAME_MARKER'; payload: { id: string; name: string } }
  | { type: 'MOVE_MARKER'; payload: { id: string; time: number } }
  | { type: 'SET_STATE'; payload: Partial<DawState> }
  | { type: 'RENAME_PROJECT'; payload: string }
  | { type: 'SET_REGION_GAIN'; payload: { id: string; gain: number } }
  | { type: 'SET_POOL_ITEM_UPLOAD_STATUS'; payload: { id: string; status: 'uploading' | 'done' | 'failed'; storagePath?: string } }
  | { type: 'SET_TRACK_ZOOM'; payload: number }
  | { type: 'SET_UI_DENSITY'; payload: 'compact' | 'standard' | 'large' }
  | { type: 'SET_PANEL_SIZE'; payload: Partial<{ inspectorWidth: number; trackListWidth: number; mixerHeight: number }> }
  | { type: 'SET_PANEL_VISIBILITY'; payload: Partial<{ inspector: boolean; mixer: boolean; mediaPool: boolean }> };

export type DawAction = DawBaseAction & { fromSync?: boolean };


const makeVersion = (num: number): TrackVersion => ({
  id: `v_${Date.now()}_${num}_${Math.random().toString(36).slice(2, 6)}`,
  name: `Version ${num}`,
});

const makeTrack = (
  name: string,
  color: string,
  type: 'mono' | 'stereo' = 'mono',
  idSuffix?: string
): Track => {
  const v1 = makeVersion(1);
  return {
    id: `t_${idSuffix ?? Date.now()}`,
    name,
    color,
    type,
    isMuted: false,
    isSolo: false,
    isArmed: false,
    isMonitoring: false,
    volume: 0.8,
    pan: 0,
    versions: [v1],
    activeVersionId: v1.id,
  };
};

const initialTracks: Track[] = [
  makeTrack('Playback', '#4db8ff', 'stereo', '0'),
  makeTrack('Audio Track',   '#808080', 'mono',   '1'),
  makeTrack('Audio Track',   '#808080', 'mono',   '2'),
  makeTrack('Audio Track',   '#808080', 'mono',   '3'),
];

export const initialState: DawState = {
  projectName: 'Untitled Project',
  projectLength: Number(localStorage.getItem('sd_projectLength') || '0') || 300,
  tracks: initialTracks,
  regions: [],
  poolItems: [],
  markers: [],
  crossfades: [],
  history: { past: [], future: [] },
  activeTool: 'select',
  selectedTrackId: initialTracks[0]?.id ?? null,
  selectedRegionId: null,
  selectedRegionIds: [],
  snapOn: true,
  snapValue: '1/16',
  trackZoom: 1.0,
  uiDensity: 'standard' as const,
  panelSizes: { inspectorWidth: 220, trackListWidth: 210, mixerHeight: 420 },
  panelVisibility: { inspector: true, mixer: true, mediaPool: true },
  transport: {
    isPlaying: false,
    isRecording: false,
    currentTime: 0,
    tempo: 120,
    timeSignature: [4, 4],
    isLooping: false,
    loopStart: 0,
    loopEnd: 16, // seconds roughly
    punchIn: null,
    punchOut: null,
    metronomeOn: false,
    countInBars: 0,
  },
};

function dawReducer(state: DawState, action: DawAction): DawState {
  switch (action.type) {
    case 'UNDO':
    case 'REDO':
    case 'SET_STATE':
    case 'RENAME_PROJECT':
    case 'SET_PLAYING':
    case 'SET_RECORDING':
    case 'SET_CURRENT_TIME':
    case 'SET_TEMPO':
    case 'TOGGLE_LOOP':
    case 'SET_LOOP_RANGE':
    case 'SET_PUNCH_RANGE':
    case 'TOGGLE_METRONOME':
    case 'SET_COUNT_IN':
    case 'SET_TOOL':
    case 'SELECT_TRACK':
    case 'SELECT_REGION':
    case 'SET_SNAP':
    case 'SET_TRACK_ZOOM':
    case 'SET_UI_DENSITY':
    case 'SET_PANEL_SIZE':
    case 'SET_PANEL_VISIBILITY':
      return coreReducer(state, action);
    default: {
      const newState = coreReducer(state, action);
      if (!action.fromSync && (newState.tracks !== state.tracks || newState.regions !== state.regions || newState.poolItems !== state.poolItems)) {
        newState.history = {
          past: [...state.history.past, { tracks: state.tracks, regions: state.regions, poolItems: state.poolItems }].slice(-50),
          future: [],
        };
      }
      return newState;
    }
  }
}

function autoProjectLength(_current: number, regions: Region[]): number {
  if (regions.length === 0) return _current;
  const maxEnd = regions.reduce((m, r) => Math.max(m, r.startTime + r.duration), 0);
  return maxEnd > 0 ? maxEnd : _current;
}

function coreReducer(state: DawState, action: DawAction): DawState {
  switch (action.type) {
    case 'UNDO': {
      if (state.history.past.length === 0) return state;
      const prev = state.history.past[state.history.past.length - 1];
      const newPast = state.history.past.slice(0, -1);
      return {
        ...state,
        tracks: prev.tracks,
        regions: prev.regions,
        poolItems: prev.poolItems,
        history: {
          past: newPast,
          future: [{ tracks: state.tracks, regions: state.regions, poolItems: state.poolItems }, ...state.history.future],
        },
      };
    }
    case 'REDO': {
      if (state.history.future.length === 0) return state;
      const next = state.history.future[0];
      const newFuture = state.history.future.slice(1);
      return {
        ...state,
        tracks: next.tracks,
        regions: next.regions,
        poolItems: next.poolItems,
        history: {
          past: [...state.history.past, { tracks: state.tracks, regions: state.regions, poolItems: state.poolItems }],
          future: newFuture,
        },
      };
    }
    case 'SET_STATE':
      return { ...state, ...action.payload };
    case 'RENAME_PROJECT':
      return { ...state, projectName: action.payload };
    case 'SET_PLAYING':
      return { ...state, transport: { ...state.transport, isPlaying: action.payload } };
    case 'SET_RECORDING':
      return { ...state, transport: { ...state.transport, isRecording: action.payload } };
    case 'SET_CURRENT_TIME':
      return { ...state, transport: { ...state.transport, currentTime: action.payload } };
    case 'SET_TEMPO':
      return { ...state, transport: { ...state.transport, tempo: action.payload } };
    case 'SET_TIME_SIGNATURE':
      return { ...state, transport: { ...state.transport, timeSignature: action.payload } };
    case 'TOGGLE_LOOP':
      return { ...state, transport: { ...state.transport, isLooping: !state.transport.isLooping } };
    case 'SET_LOOP_RANGE':
      return { ...state, transport: { ...state.transport, loopStart: action.payload.start, loopEnd: action.payload.end } };
    case 'SET_PUNCH_RANGE':
      return { ...state, transport: { ...state.transport, punchIn: action.payload.start, punchOut: action.payload.end } };
    case 'TOGGLE_METRONOME':
      return { ...state, transport: { ...state.transport, metronomeOn: !state.transport.metronomeOn } };
    case 'SET_COUNT_IN':
      return { ...state, transport: { ...state.transport, countInBars: action.payload } };

    case 'SET_TOOL':
      return { ...state, activeTool: action.payload };
    case 'SELECT_TRACK':
      return { ...state, selectedTrackId: action.payload };
    case 'SELECT_REGION':
      return { ...state, selectedRegionId: action.payload, selectedRegionIds: [] };
    case 'SELECT_REGIONS':
      return { ...state, selectedRegionIds: action.payload, selectedRegionId: null };

    case 'ADD_TRACK': {
      const trackType = action.payload?.trackType ?? 'mono';
      const monoCount = state.tracks.filter(t => t.type === 'mono').length;
      const color = trackType === 'stereo'
        ? '#4db8ff'
        : TRACK_DEFAULT_COLORS[monoCount % TRACK_DEFAULT_COLORS.length];
      const name = trackType === 'stereo' ? 'Playback' : 'Audio Track';
      const newTrack = makeTrack(name, color, trackType);
      // Stereo tracks always inserted at the top
      if (trackType === 'stereo') {
        return { ...state, tracks: [newTrack, ...state.tracks] };
      }
      return { ...state, tracks: [...state.tracks, newTrack] };
    }

    case 'DUPLICATE_TRACK': {
      const srcTrack = state.tracks.find(t => t.id === action.payload);
      if (!srcTrack) return state;
      const stamp = Date.now();
      const newVersion = makeVersion(1);
      const newTrack: Track = {
        ...srcTrack,
        id: `t_dup_${stamp}`,
        versions: [newVersion],
        activeVersionId: newVersion.id,
      };
      // Copy all regions from the source track's active version to the new track/version
      const copiedRegions: Region[] = state.regions
        .filter(r => r.trackId === srcTrack.id && r.versionId === srcTrack.activeVersionId)
        .map((r, i) => ({ ...r, id: `r_dup_${stamp}_${i}`, trackId: newTrack.id, versionId: newVersion.id }));
      const srcIdx = state.tracks.findIndex(t => t.id === srcTrack.id);
      const newTracks = [...state.tracks.slice(0, srcIdx + 1), newTrack, ...state.tracks.slice(srcIdx + 1)];
      const newRegions = [...state.regions, ...copiedRegions];
      return {
        ...state,
        tracks: newTracks,
        regions: newRegions,
        selectedTrackId: newTrack.id,
        projectLength: autoProjectLength(state.projectLength, newRegions),
      };
    }

    case 'REORDER_TRACKS':
      return { ...state, tracks: action.payload };

    case 'UPDATE_TRACK':
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.id ? { ...t, ...action.payload.updates } : t
        ),
      };
    case 'RENAME_TRACK':
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.id ? { ...t, name: action.payload.name } : t
        ),
      };
    case 'REMOVE_TRACK':
      return {
        ...state,
        tracks: state.tracks.filter(t => t.id !== action.payload),
        regions: state.regions.filter(r => r.trackId !== action.payload),
      };

    case 'ADD_VERSION': {
      const track = state.tracks.find(t => t.id === action.payload.trackId);
      if (!track) return state;
      const newVersion = makeVersion(track.versions.length + 1);
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.trackId
            ? { ...t, versions: [...t.versions, newVersion], activeVersionId: newVersion.id }
            : t
        ),
      };
    }

    case 'SWITCH_VERSION':
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.trackId
            ? { ...t, activeVersionId: action.payload.versionId }
            : t
        ),
      };

    case 'ADD_REGION': {
      const newRegions = [...state.regions, action.payload];
      return { ...state, regions: newRegions, projectLength: autoProjectLength(state.projectLength, newRegions) };
    }

    case 'REMOVE_REGION': {
      const newRegions = state.regions.filter(r => r.id !== action.payload);
      return {
        ...state,
        regions: newRegions,
        crossfades: state.crossfades.filter(cf => cf.regionA !== action.payload && cf.regionB !== action.payload),
        selectedRegionIds: state.selectedRegionIds.filter(id => id !== action.payload),
        projectLength: autoProjectLength(state.projectLength, newRegions),
      };
    }

    case 'ADD_CROSSFADE': {
      const { regionA, regionB } = action.payload;
      const existingIdx = state.crossfades.findIndex(
        cf => (cf.regionA === regionA && cf.regionB === regionB) ||
              (cf.regionA === regionB && cf.regionB === regionA)
      );
      if (existingIdx >= 0) {
        // Toggle off if same pair exists
        return { ...state, crossfades: state.crossfades.filter((_, i) => i !== existingIdx) };
      }
      return { ...state, crossfades: [...state.crossfades, { id: `cf_${Date.now()}`, regionA, regionB }] };
    }

    case 'REMOVE_CROSSFADE':
      return { ...state, crossfades: state.crossfades.filter(cf => cf.id !== action.payload) };

    case 'MOVE_REGION': {
      const { regionId, startTime, trackId } = action.payload;
      const newRegions = state.regions.map(r => {
        if (r.id !== regionId) return r;
        const upd: Partial<Region> = {};
        if (startTime !== undefined) upd.startTime = Math.max(0, startTime);
        if (trackId !== undefined) {
          const track = state.tracks.find(t => t.id === trackId);
          if (track) { upd.trackId = trackId; upd.versionId = track.activeVersionId; }
        }
        return { ...r, ...upd };
      });
      return { ...state, regions: newRegions, projectLength: autoProjectLength(state.projectLength, newRegions) };
    }

    case 'SPLIT_REGION': {
      const { regionId, splitTime } = action.payload;
      const orig = state.regions.find(r => r.id === regionId);
      if (!orig) return state;
      if (splitTime <= orig.startTime || splitTime >= orig.startTime + orig.duration) return state;

      const leftDur    = splitTime - orig.startTime;
      const rightDur   = orig.duration - leftDur;
      const ratio      = leftDur / orig.duration;
      const peakMid    = Math.floor(orig.waveformPeaks.length * ratio);
      const peakMidR   = orig.waveformPeaksR ? Math.floor(orig.waveformPeaksR.length * ratio) : 0;
      const stamp      = Date.now();

      const left: Region = {
        ...orig, id: `${regionId}_l${stamp}`,
        duration: leftDur,
        waveformPeaks:  orig.waveformPeaks.slice(0, peakMid),
        waveformPeaksR: orig.waveformPeaksR ? orig.waveformPeaksR.slice(0, peakMidR) : orig.waveformPeaksR,
        audioOffset: orig.audioOffset ?? 0,
        sourceDuration: orig.sourceDuration,
        // Source peaks propagate unsliced — both halves window the same source file
        sourcePeaks:  orig.sourcePeaks,
        sourcePeaksR: orig.sourcePeaksR,
      };
      const right: Region = {
        ...orig, id: `${regionId}_r${stamp}`,
        startTime: splitTime,
        duration: rightDur,
        waveformPeaks:  orig.waveformPeaks.slice(peakMid),
        waveformPeaksR: orig.waveformPeaksR ? orig.waveformPeaksR.slice(peakMidR) : orig.waveformPeaksR,
        audioOffset: (orig.audioOffset ?? 0) + leftDur,
        sourceDuration: orig.sourceDuration,
        sourcePeaks:  orig.sourcePeaks,
        sourcePeaksR: orig.sourcePeaksR,
      };

      const idx = state.regions.findIndex(r => r.id === regionId);
      return {
        ...state,
        regions: [
          ...state.regions.slice(0, idx),
          left, right,
          ...state.regions.slice(idx + 1),
        ],
      };
    }

    case 'UPDATE_REGION':
      return {
        ...state,
        regions: state.regions.map(r =>
          r.id === action.payload.id ? { ...r, ...action.payload.updates } : r
        ),
      };

    case 'RENAME_REGION':
      return {
        ...state,
        regions: state.regions.map(r =>
          r.id === action.payload.id ? { ...r, name: action.payload.name } : r
        ),
      };

    case 'SET_REGION_GAIN':
      return {
        ...state,
        regions: state.regions.map(r =>
          r.id === action.payload.id ? { ...r, gain: action.payload.gain } : r
        ),
      };

    case 'SET_POOL_ITEM_UPLOAD_STATUS':
      return {
        ...state,
        poolItems: state.poolItems.map(p =>
          p.id === action.payload.id
            ? { ...p, uploadStatus: action.payload.status, ...(action.payload.storagePath && { storagePath: action.payload.storagePath }) }
            : p
        ),
      };

    case 'TOGGLE_REGION_MUTE':
      return {
        ...state,
        regions: state.regions.map(r =>
          r.id === action.payload ? { ...r, isMuted: !r.isMuted } : r
        ),
      };

    case 'TRIM_REGION': {
      const { regionId, startTime, duration, audioOffset } = action.payload;
      const newRegions = state.regions.map(r =>
        r.id === regionId
          ? { ...r, startTime: Math.max(0, startTime), duration: Math.max(0.05, duration), audioOffset }
          : r
      );
      return { ...state, regions: newRegions, projectLength: autoProjectLength(state.projectLength, newRegions) };
    }

    case 'RENDER_REGIONS': {
      const region = state.regions.find(r => r.id === action.payload);
      if (!region) return state;
      const next = state.regions
        .filter(r =>
          r.trackId   === region.trackId &&
          r.versionId === region.versionId &&
          r.id        !== region.id &&
          r.startTime >= region.startTime + region.duration - 0.05
        )
        .sort((a, b) => a.startTime - b.startTime)[0];
      if (!next) return state;
      return {
        ...state,
        regions: state.regions
          .filter(r => r.id !== next.id)
          .map(r => r.id === region.id
            ? {
                ...r,
                duration: (next.startTime + next.duration) - r.startTime,
                waveformPeaks: [...r.waveformPeaks, ...next.waveformPeaks],
                waveformPeaksR: (r.waveformPeaksR && next.waveformPeaksR)
                  ? [...r.waveformPeaksR, ...next.waveformPeaksR]
                  : null,
              }
            : r
          ),
      };
    }
    case 'SET_PROJECT_LENGTH':
      return { ...state, projectLength: action.payload };
    case 'SET_SNAP':
      return { ...state, snapOn: action.payload.on, snapValue: action.payload.value };

    case 'ADD_POOL_ITEM':
      return { ...state, poolItems: [action.payload, ...state.poolItems] };
    case 'REMOVE_POOL_ITEM':
      return { ...state, poolItems: state.poolItems.filter(p => p.id !== action.payload) };

    case 'UPDATE_AUDIO_URLS': {
      const { poolItemId, audioUrl } = action.payload;
      return {
        ...state,
        poolItems: state.poolItems.map(p => p.id === poolItemId ? { ...p, audioUrl } : p),
        // Match by poolItemId (stable) — name matching was fragile and could affect wrong regions
        regions: state.regions.map(r => r.poolItemId === poolItemId ? { ...r, audioUrl } : r),
      };
    }

    case 'RENAME_VERSION':
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.trackId
            ? { ...t, versions: t.versions.map(v =>
                v.id === action.payload.versionId ? { ...v, name: action.payload.name } : v
              )}
            : t
        ),
      };

    case 'ADD_TRACK_AND_MOVE_REGION': {
      const monoCount2 = state.tracks.filter(t => t.type === 'mono').length;
      const newColor = TRACK_DEFAULT_COLORS[monoCount2 % TRACK_DEFAULT_COLORS.length];
      const newTrack = makeTrack('Audio Track', newColor, action.payload.trackType ?? 'mono');
      return {
        ...state,
        tracks: [...state.tracks, newTrack],
        regions: state.regions.map(r =>
          r.id === action.payload.regionId
            ? { ...r, trackId: newTrack.id, versionId: newTrack.activeVersionId }
            : r
        ),
      };
    }

    case 'BOUNCE_REGIONS': {
      const { regionIds, newRegion, newPoolItem } = action.payload;
      const newRegions = [...state.regions.filter(r => !regionIds.includes(r.id)), newRegion];
      return {
        ...state,
        regions: newRegions,
        poolItems: [newPoolItem, ...state.poolItems],
        projectLength: autoProjectLength(state.projectLength, newRegions),
      };
    }

    case 'RESIZE_TRACK':
      return {
        ...state,
        tracks: state.tracks.map(t =>
          t.id === action.payload.id ? { ...t, height: action.payload.height } : t
        ),
      };

    case 'ADD_MARKER':
      return { ...state, markers: [...state.markers, action.payload] };
    case 'REMOVE_MARKER':
      return { ...state, markers: state.markers.filter(m => m.id !== action.payload) };
    case 'RENAME_MARKER':
      return {
        ...state,
        markers: state.markers.map(m =>
          m.id === action.payload.id ? { ...m, name: action.payload.name } : m
        ),
      };
    case 'MOVE_MARKER':
      return {
        ...state,
        markers: state.markers.map(m =>
          m.id === action.payload.id ? { ...m, time: action.payload.time } : m
        ),
      };

    case 'SET_TRACK_ZOOM': {
      const scale = action.payload / state.trackZoom;
      return {
        ...state,
        trackZoom: action.payload,
        tracks: state.tracks.map(t => ({
          ...t,
          height: Math.max(50, Math.round((t.height ?? 80) * scale)),
        })),
      };
    }
    case 'SET_UI_DENSITY':
      return { ...state, uiDensity: action.payload };
    case 'SET_PANEL_SIZE':
      return { ...state, panelSizes: { ...state.panelSizes, ...action.payload } };
    case 'SET_PANEL_VISIBILITY':
      return { ...state, panelVisibility: { ...state.panelVisibility, ...action.payload } };

    default:
      return state;
  }
}

interface DawContextValue {
  state: DawState;
  dispatch: React.Dispatch<DawAction>;
  originalDispatch: React.Dispatch<DawAction>;
  setDispatchMiddleware: (mw: ((action: DawAction) => void) | null) => void;
  currentTimeRef: React.MutableRefObject<number>;
  audioCtxRef: React.MutableRefObject<AudioContext | null>;
  recordingStartTimeRef: React.MutableRefObject<number>;
  animFrameRef: React.MutableRefObject<number | null>;
  masterStreamRef: React.MutableRefObject<MediaStreamAudioDestinationNode | null>;
  userRole: 'artist' | 'engineer';
  livePeaksRef: React.MutableRefObject<number[]>;
  trackAnalysersRef: React.MutableRefObject<Record<string, AnalyserNode>>;
  trackGainsRef: React.MutableRefObject<Record<string, GainNode>>;
  trackPannersRef: React.MutableRefObject<Record<string, StereoPannerNode>>;
  masterGainRef: React.MutableRefObject<GainNode | null>;
  masterAnalyserRef: React.MutableRefObject<AnalyserNode | null>;
  nativeMasterLevelsRef: React.MutableRefObject<[number, number]>;

  // Local Project storage handles (Chrome/Edge File System Access API)
  projectDirHandle: any | null;
  setProjectDirHandle: (handle: any | null) => void;
  audioDirHandle: any | null;
  setAudioDirHandle: (handle: any | null) => void;

  // Set by useAudioEngine so any component can trigger a re-upload by pool item id
  retryUploadRef: React.MutableRefObject<((poolItemId: string) => void) | null>;

  meterValuesRef: React.MutableRefObject<Record<string, MeterValue>>;
  clearMeterClip: (id: string) => void;
}

interface DawProviderProps {
  children: React.ReactNode;
  userRole: 'artist' | 'engineer';
}

const DawContext = createContext<DawContextValue | null>(null);

export const DawProvider: React.FC<DawProviderProps> = ({ children, userRole }) => {
  const [state, originalDispatch] = useReducer(dawReducer, initialState);
  const middlewareRef = useRef<((action: DawAction) => void) | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const currentTimeRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef(0);
  const livePeaksRef = useRef<number[]>([]);
  const masterStreamRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const trackAnalysersRef  = useRef<Record<string, AnalyserNode>>({});
  const trackGainsRef      = useRef<Record<string, GainNode>>({});
  const trackPannersRef    = useRef<Record<string, StereoPannerNode>>({});
  const masterGainRef           = useRef<GainNode | null>(null);
  const masterAnalyserRef       = useRef<AnalyserNode | null>(null);
  const nativeMasterLevelsRef   = useRef<[number, number]>([0, 0]);

  const [projectDirHandle, setProjectDirHandle] = React.useState<any | null>(null);
  const [audioDirHandle, setAudioDirHandle] = React.useState<any | null>(null);
  const retryUploadRef = useRef<((poolItemId: string) => void) | null>(null);
  const meterValuesRef = useRef<Record<string, MeterValue>>({});
  const clearMeterClip = useCallback((id: string) => {
    const v = meterValuesRef.current[id];
    if (v) { v.clipL = false; v.clipR = false; }
  }, []);

  const dispatch = useCallback((action: DawAction) => {
    if (middlewareRef.current) {
      middlewareRef.current(action);
    } else {
      originalDispatch(action);
    }
  }, [originalDispatch]);

  const setDispatchMiddleware = useCallback((mw: ((action: DawAction) => void) | null) => {
    middlewareRef.current = mw;
  }, []);

  return (
    <DawContext.Provider value={{
      state, dispatch, originalDispatch, setDispatchMiddleware, currentTimeRef, audioCtxRef, recordingStartTimeRef, animFrameRef, masterStreamRef, livePeaksRef, trackAnalysersRef, trackGainsRef, trackPannersRef, masterGainRef, masterAnalyserRef, nativeMasterLevelsRef, userRole,
      projectDirHandle, setProjectDirHandle, audioDirHandle, setAudioDirHandle,
      retryUploadRef,
      meterValuesRef, clearMeterClip,
    }}>
      {children}
    </DawContext.Provider>
  );
};

export const useDaw = (): DawContextValue => {
  const ctx = useContext(DawContext);
  if (!ctx) throw new Error('useDaw must be used within DawProvider');
  return ctx;
};

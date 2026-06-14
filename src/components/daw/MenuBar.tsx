import { useState, useRef, useEffect, useCallback } from 'react';
import { useDaw } from '../../context/DawContext';
import { initialState } from '../../context/DawContext';
import type { Region, PoolItem } from '../../context/DawContext';
import { supabase } from '../../lib/supabaseClient';
import { saveToAudioFolder, generatePeaksStereo } from '../../utils/audioUtils';
import { exportToWav, exportStems, consolidateTrack } from '../../utils/exportUtils';
import './MenuBar.css';

interface MenuItem {
  label: string;
  shortcut?: string;
  separator?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

interface MenuBarProps {
  onOpenAudioPrefs?: () => void;
  onCloseProject?: () => void;
}

const SHORTCUT_LIST = [
  { key: 'Space',           action: 'Play / Stop (return to start)' },
  { key: 'R',               action: 'Toggle Record' },
  { key: 'Num 0 / Enter',   action: 'Return to Zero' },
  { key: 'Ctrl+Z',          action: 'Undo' },
  { key: 'Ctrl+Shift+Z',    action: 'Redo' },
  { key: 'Ctrl+S',          action: 'Save Project' },
  { key: 'Ctrl+Shift+S',    action: 'Save As…' },
  { key: 'Ctrl+L',          action: 'Toggle Loop' },
  { key: 'Ctrl+M',          action: 'Toggle Metronome' },
  { key: 'Ctrl+A',          action: 'Select All Clips' },
  { key: 'F4',              action: 'Audio Setup' },
  { key: 'Delete / Bksp',  action: 'Delete Selected Clip' },
  { key: '1',               action: 'Select Tool' },
  { key: '2',               action: 'Range Tool' },
  { key: '3',               action: 'Split Tool' },
  { key: '4',               action: 'Render Tool' },
  { key: '5',               action: 'Erase Tool' },
  { key: '6',               action: 'Zoom Tool' },
  { key: '7',               action: 'Mute Tool' },
  { key: '8',               action: 'Draw Tool' },
  { key: 'G / H',           action: 'Zoom In / Out (Arrange)' },
  { key: 'Shift+G / H',     action: 'Track Height Increase / Decrease' },
  { key: 'Ctrl+Scroll',     action: 'Horizontal Zoom' },
  { key: 'B',               action: 'Bounce Selected Clip' },
  { key: 'Shift+B',        action: 'Bounce Track (loop range or full track)' },
  { key: 'A / B',           action: 'Switch Stereo Track Version' },
  { key: 'Ctrl+D',          action: 'Duplicate Selected Clip' },
  { key: 'X',               action: 'Split Clip at Cursor' },
  { key: 'Double-click clip', action: 'Rename Clip (Select tool)' },
  { key: 'Drag fade knob',  action: 'Set Fade In / Fade Out' },
];

const MenuBar: React.FC<MenuBarProps> = ({
  onOpenAudioPrefs, onCloseProject,
}) => {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [localToast, setLocalToast] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showNotepad, setShowNotepad] = useState(false);
  const [showProjectSetup, setShowProjectSetup] = useState(false);
  const [showProjectLength, setShowProjectLength] = useState(false);
  const [projectLengthMin, setProjectLengthMin] = useState(() => {
    const saved = localStorage.getItem('sd_projectLength');
    return saved ? Math.floor(Number(saved) / 60) : 5;
  });
  const [projectLengthSec, setProjectLengthSec] = useState(() => {
    const saved = localStorage.getItem('sd_projectLength');
    return saved ? Number(saved) % 60 : 0;
  });
  const [notepadText, setNotepadText] = useState(() => localStorage.getItem('sd_notepad') || '');
  const [projectTempo, setProjectTempo] = useState(0);
  const [exportProgress, setExportProgress] = useState<string | null>(null);

  const barRef = useRef<HTMLDivElement>(null);
  const clipboardRef = useRef<Region | null>(null);

  const { dispatch, state, setProjectDirHandle, setAudioDirHandle, projectDirHandle, audioDirHandle, currentTimeRef } = useDaw();
  const projectName = state.projectName ?? 'Untitled Project';
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName);

  const toast = useCallback((msg: string) => {
    setLocalToast(msg);
    setTimeout(() => setLocalToast(null), 2500);
  }, []);

  // ── Project I/O ──────────────────────────────────────────────────────

  const handleSave = useCallback(async (dirHandle = projectDirHandle) => {
    if (!dirHandle) { handleSaveAs(); return; }
    try {
      const fh = await dirHandle.getFileHandle('project.json', { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(state, null, 2));
      await w.close();
      toast('Project saved.');
    } catch (err) { console.error('Save error:', err); toast('Save failed.'); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDirHandle, state, toast]);

  const handleSaveAs = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      alert('Local folder saving is only supported in Chrome or Edge.');
      return;
    }
    try {
      // @ts-ignore
      const dh = await window.showDirectoryPicker({ mode: 'readwrite' });
      setProjectDirHandle(dh);
      const adh = await dh.getDirectoryHandle('Audio', { create: true });
      setAudioDirHandle(adh);
      dispatch({ type: 'RENAME_PROJECT', payload: dh.name });
      const fh = await dh.getFileHandle('project.json', { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify({ ...state, projectName: dh.name }, null, 2));
      await w.close();
      toast(`Saved to: ${dh.name}`);
    } catch (err: any) {
      if (err.name !== 'AbortError') alert('Failed to save project. Grant folder permissions and try again.');
    }
  }, [state, setProjectDirHandle, setAudioDirHandle, toast]);


  const handleOpenProject = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      alert('Opening projects from disk is only supported in Chrome or Edge.');
      return;
    }
    try {
      // @ts-ignore
      const dh = await window.showDirectoryPicker({ mode: 'readwrite' });
      const fh = await dh.getFileHandle('project.json');
      const file = await fh.getFile();
      const saved = JSON.parse(await file.text());
      setProjectDirHandle(dh);
      // @ts-ignore
      const adh = await dh.getDirectoryHandle('Audio', { create: true });
      setAudioDirHandle(adh);

      // Restore blob URLs from local Audio/ folder for pool items and regions
      const urlMap: Record<string, string> = {};
      for (const item of (saved.poolItems ?? []) as any[]) {
        if (item.localFileName) {
          try {
            // @ts-ignore
            const itemFh = await adh.getFileHandle(item.localFileName);
            const itemFile = await itemFh.getFile();
            urlMap[item.id] = URL.createObjectURL(itemFile);
          } catch { /* file missing — keep whatever URL was saved */ }
        }
      }

      if (Object.keys(urlMap).length > 0) {
        saved.poolItems = (saved.poolItems ?? []).map((p: any) =>
          urlMap[p.id] ? { ...p, audioUrl: urlMap[p.id] } : p
        );
        // Match regions to pool items by name to update their audioUrl too
        const poolByName: Record<string, string> = {};
        for (const p of saved.poolItems) if (urlMap[p.id]) poolByName[p.name] = urlMap[p.id];
        saved.regions = (saved.regions ?? []).map((r: any) =>
          poolByName[r.name] ? { ...r, audioUrl: poolByName[r.name] } : r
        );
      }

      dispatch({ type: 'SET_STATE', payload: saved });
      toast(`Opened: ${dh.name}`);
    } catch (err: any) {
      if (err.name !== 'AbortError') toast('No project.json found in that folder.');
    }
  }, [dispatch, setProjectDirHandle, setAudioDirHandle, toast]);

  const handleNewProject = useCallback(() => {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
    dispatch({ type: 'SET_STATE', payload: initialState });
    setProjectDirHandle(null);
    setAudioDirHandle(null);
    toast('New project created.');
  }, [dispatch, setProjectDirHandle, setAudioDirHandle, toast]);

  const handleImportAudio = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const actx = new AudioContext();
        const buf = await actx.decodeAudioData(await file.arrayBuffer());
        const duration = buf.duration;
        const { left: peaks, right: rawPeaksR } = await generatePeaksStereo(buf);
        await actx.close();
        const poolItemId = `pool_${Date.now()}`;
        const poolItem: PoolItem = {
          id: poolItemId,
          name: file.name.replace(/\.[^.]+$/, ''),
          audioUrl: url,
          localFileName: file.name,
          duration,
          createdAt: new Date(),
          waveformPeaks: peaks,
          waveformPeaksR: rawPeaksR,
        };
        dispatch({ type: 'ADD_POOL_ITEM', payload: poolItem });
        if (state.selectedTrackId) {
          const track = state.tracks.find(t => t.id === state.selectedTrackId);
          if (track) {
            const peaksR = track.type === 'stereo' ? rawPeaksR : null;
            dispatch({
              type: 'ADD_REGION',
              payload: {
                id: `r_${Date.now()}`,
                poolItemId,
                trackId: track.id,
                versionId: track.activeVersionId,
                startTime: currentTimeRef.current,
                duration,
                name: poolItem.name,
                audioUrl: url,
                waveformPeaks: peaks,
                waveformPeaksR: peaksR,
                sourceDuration: duration,
                sourcePeaks: peaks,
                sourcePeaksR: rawPeaksR,
              },
            });
          }
        }
        // Save as 24-bit WAV into the project's Audio/ folder
        if (audioDirHandle) {
          try {
            await saveToAudioFolder(audioDirHandle, poolItem.name, buf);
          } catch (err) { console.error('Audio folder save failed:', err); }
        }
        toast(`Imported: ${poolItem.name}`);
      } catch { toast('Could not decode audio file.'); }
    };
    input.click();
  }, [dispatch, state.selectedTrackId, state.tracks, currentTimeRef, audioDirHandle, toast]);

  // ── Clipboard ────────────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    if (!state.selectedRegionId) { toast('Select a region first.'); return; }
    const r = state.regions.find(r => r.id === state.selectedRegionId);
    if (r) { clipboardRef.current = { ...r }; toast('Region copied.'); }
  }, [state.selectedRegionId, state.regions, toast]);

  const handleCut = useCallback(() => {
    if (!state.selectedRegionId) { toast('Select a region first.'); return; }
    handleCopy();
    dispatch({ type: 'REMOVE_REGION', payload: state.selectedRegionId });
    dispatch({ type: 'SELECT_REGION', payload: null });
  }, [state.selectedRegionId, handleCopy, dispatch, toast]);

  const handlePaste = useCallback(() => {
    const src = clipboardRef.current;
    if (!src) { toast('Nothing to paste.'); return; }
    const trackId = state.selectedTrackId ?? src.trackId;
    const track = state.tracks.find(t => t.id === trackId);
    if (!track) { toast('Select a target track first.'); return; }
    const newRegion: Region = {
      ...src,
      id: `r_${Date.now()}`,
      trackId: track.id,
      versionId: track.activeVersionId,
      startTime: currentTimeRef.current,
    };
    dispatch({ type: 'ADD_REGION', payload: newRegion });
    dispatch({ type: 'SELECT_REGION', payload: newRegion.id });
  }, [state.selectedTrackId, state.tracks, currentTimeRef, dispatch, toast]);

  const handleDelete = useCallback(() => {
    if (!state.selectedRegionId) { toast('No region selected.'); return; }
    dispatch({ type: 'REMOVE_REGION', payload: state.selectedRegionId });
    dispatch({ type: 'SELECT_REGION', payload: null });
  }, [state.selectedRegionId, dispatch, toast]);

  const handleSelectAll = useCallback(() => {
    const first = state.regions.find(r => r.trackId === state.selectedTrackId);
    if (first) dispatch({ type: 'SELECT_REGION', payload: first.id });
    else toast('No regions on selected track.');
  }, [state.regions, state.selectedTrackId, dispatch, toast]);

  // ── Export ───────────────────────────────────────────────────────────

  const handleExportMixdown = useCallback(async () => {
    try {
      setExportProgress('Rendering mixdown…');
      await exportToWav(state, projectName, pct => {
        setExportProgress(`Rendering… ${Math.round(pct * 100)}%`);
      });
      toast('Mixdown exported.');
    } catch (err: any) {
      toast(`Export failed: ${err?.message ?? err}`);
    } finally {
      setExportProgress(null);
    }
  }, [state, projectName, toast]);

  const handleExportStems = useCallback(async () => {
    try {
      setExportProgress('Preparing stems…');
      await exportStems(state, projectName, msg => setExportProgress(msg));
      toast('Stems exported as ZIP.');
    } catch (err: any) {
      toast(`Export failed: ${err?.message ?? err}`);
    } finally {
      setExportProgress(null);
    }
  }, [state, projectName, toast]);

  const handleConsolidateTrack = useCallback(async () => {
    const trackId = state.selectedTrackId;
    if (!trackId) { toast('Select a track first.'); return; }
    try {
      setExportProgress('Consolidating track…');
      const result = await consolidateTrack(state, trackId, msg => setExportProgress(msg));
      if (!result) { toast('No clips on selected track.'); return; }
      const url = URL.createObjectURL(result.blob);
      const a   = document.createElement('a');
      a.href = url; a.download = `${result.name}.wav`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`Consolidated: ${result.name}`);
    } catch (err: any) {
      toast(`Consolidate failed: ${err?.message ?? err}`);
    } finally {
      setExportProgress(null);
    }
  }, [state, toast]);

  // ── Seek ─────────────────────────────────────────────────────────────

  const handleRewind = useCallback(() => {
    const t = Math.max(0, currentTimeRef.current - 5);
    currentTimeRef.current = t;
    dispatch({ type: 'SET_CURRENT_TIME', payload: t });
  }, [currentTimeRef, dispatch]);

  const handleForward = useCallback(() => {
    const t = currentTimeRef.current + 5;
    currentTimeRef.current = t;
    dispatch({ type: 'SET_CURRENT_TIME', payload: t });
  }, [currentTimeRef, dispatch]);

  // ── Menus definition ──────────────────────────────────────────────────

  const MENUS: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project',           shortcut: 'Ctrl+N',       onClick: handleNewProject },
        { label: 'Open Project…',         shortcut: 'Ctrl+O',       onClick: handleOpenProject },
        { label: 'Open Recent',           disabled: true },
        { separator: true, label: '' },
        { label: 'Close Project',         onClick: onCloseProject ?? (() => toast('No session to close.')) },
        { separator: true, label: '' },
        { label: 'Save',                  shortcut: 'Ctrl+S',       onClick: () => handleSave() },
        { label: 'Save As…',              shortcut: 'Ctrl+Shift+S', onClick: handleSaveAs },
        { separator: true, label: '' },
        { label: 'Import Audio File…',                              onClick: handleImportAudio },
        { separator: true, label: '' },
        { label: 'Export Mixdown…',    onClick: handleExportMixdown },
        { label: 'Export Stems…',      onClick: handleExportStems },
        { label: 'Consolidate Track…', onClick: handleConsolidateTrack },
        { separator: true, label: '' },
        { label: 'Sign Out', onClick: async () => { await supabase.auth.signOut(); window.location.reload(); } },
        { label: 'Quit', shortcut: 'Ctrl+Q', onClick: () => { if (confirm('Quit StudioDESK?')) window.close(); } },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo',        shortcut: 'Ctrl+Z',       disabled: state.history.past.length === 0,   onClick: () => dispatch({ type: 'UNDO' }) },
        { label: 'Redo',        shortcut: 'Ctrl+Shift+Z', disabled: state.history.future.length === 0,  onClick: () => dispatch({ type: 'REDO' }) },
        { label: 'History…',   disabled: true },
        { separator: true, label: '' },
        { label: 'Cut',         shortcut: 'Ctrl+X', onClick: handleCut },
        { label: 'Copy',        shortcut: 'Ctrl+C', onClick: handleCopy },
        { label: 'Paste',       shortcut: 'Ctrl+V', onClick: handlePaste },
        { label: 'Delete',      shortcut: 'Del',    onClick: handleDelete },
        { separator: true, label: '' },
        { label: 'Select All Clips', shortcut: 'Ctrl+A', onClick: handleSelectAll },
        { label: 'Deselect All',                         onClick: () => dispatch({ type: 'SELECT_REGION', payload: null }) },
      ],
    },
    {
      label: 'Project',
      items: [
        { label: 'Project Setup…',      onClick: () => { setProjectTempo(state.transport.tempo); setShowProjectSetup(true); } },
        { label: 'Project Properties…', onClick: () => { setProjectTempo(state.transport.tempo); setShowProjectSetup(true); } },
        { label: 'Notepad',             onClick: () => setShowNotepad(true) },
        { separator: true, label: '' },
        { label: 'Add Audio Track',     onClick: () => { dispatch({ type: 'ADD_TRACK', payload: { trackType: 'mono' } }); toast('Audio track added.'); } },
        { label: 'Add Playback Track',  onClick: () => { dispatch({ type: 'ADD_TRACK', payload: { trackType: 'stereo' } }); toast('Playback track added.'); } },
        { separator: true, label: '' },
        { label: 'Markers', onClick: () => {
          dispatch({ type: 'ADD_MARKER', payload: { id: `mk_${Date.now()}`, time: currentTimeRef.current, name: 'Marker' } });
          toast('Marker added at playhead.');
        }},
      ],
    },
    {
      label: 'Audio',
      items: [
        { label: 'Audio Setup…', shortcut: 'F4', onClick: onOpenAudioPrefs },
      ],
    },
    {
      label: 'Transport',
      items: [
        { label: 'Play',            shortcut: 'Space',  onClick: () => dispatch({ type: 'SET_PLAYING', payload: !state.transport.isPlaying }) },
        { label: 'Record',          shortcut: 'R',      onClick: () => dispatch({ type: 'SET_RECORDING', payload: !state.transport.isRecording }) },
        { label: 'Return to Zero',  shortcut: 'Num 0',  onClick: () => dispatch({ type: 'SET_CURRENT_TIME', payload: 0 }) },
        { label: 'Rewind  (−5 s)',  shortcut: 'Num −',  onClick: handleRewind },
        { label: 'Forward (+5 s)',  shortcut: 'Num +',  onClick: handleForward },
        { separator: true, label: '' },
        { label: 'Toggle Loop',      shortcut: 'Ctrl+L', onClick: () => dispatch({ type: 'TOGGLE_LOOP' }) },
        { label: 'Metronome On/Off', shortcut: 'Ctrl+M', onClick: () => dispatch({ type: 'TOGGLE_METRONOME' }) },
      ],
    },
    {
      label: 'Settings',
      items: [
        { label: 'Audio Setup…',      shortcut: 'F4', onClick: onOpenAudioPrefs },
        { label: 'Shortcuts…',                        onClick: () => setShowShortcuts(true) },
        { separator: true, label: '' },
        { label: 'Project Length…',                   onClick: () => setShowProjectLength(true) },
        { separator: true, label: '' },
        { label: 'Plug-ins', onClick: () => toast('VST3 plug-in support coming in a future update.') },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Documentation',      onClick: () => window.open('https://github.com/shantileemedia-developer/studiodesk', '_blank') },
        { label: 'Video Tutorials',    onClick: () => toast('Video tutorials coming soon.') },
        { separator: true, label: '' },
        { label: 'Check for Updates…', onClick: () => window.open('https://github.com/shantileemedia-developer/studiodesk/releases', '_blank') },
        { label: 'About StudioDESK',   onClick: () => setShowAbout(true) },
      ],
    },
  ];

  // ── Close / keyboard handlers ─────────────────────────────────────────

  useEffect(() => {
    if (openMenu === null) return;
    const h = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [openMenu]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpenMenu(null); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const toggleMenu = useCallback((idx: number) => {
    setOpenMenu(prev => (prev === idx ? null : idx));
  }, []);

  const handleItemClick = useCallback((item: MenuItem) => {
    if (item.separator || item.disabled) return;
    item.onClick?.();
    setOpenMenu(null);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <>
      <div className="menu-bar" ref={barRef}>
        <div className="menu-bar-logo">
          <span className="menu-bar-brand">StudioDESK</span>
        </div>

        <div className="menu-bar-menus">
          {MENUS.map((menu, idx) => (
            <div
              key={menu.label}
              className={`menu-bar-item ${openMenu === idx ? 'open' : ''}`}
              onClick={() => toggleMenu(idx)}
              onMouseEnter={() => { if (openMenu !== null) setOpenMenu(idx); }}
            >
              <span className="menu-bar-label">{menu.label}</span>

              {openMenu === idx && (
                <div className="menu-dropdown" onClick={e => e.stopPropagation()}>
                  {menu.items.map((item, i) =>
                    item.separator ? (
                      <div key={`sep-${i}`} className="menu-separator" />
                    ) : (
                      <div
                        key={item.label}
                        className={`menu-item ${item.disabled ? 'disabled' : ''}`}
                        onClick={() => handleItemClick(item)}
                      >
                        <span className="menu-item-label">{item.label}</span>
                        {item.shortcut && (
                          <span className="menu-item-shortcut">{item.shortcut}</span>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="menu-bar-project">
          {editingName ? (
            <input
              className="menu-project-name-input"
              value={nameInput}
              autoFocus
              onChange={e => setNameInput(e.target.value)}
              onBlur={() => {
                const trimmed = nameInput.trim() || 'Untitled Project';
                dispatch({ type: 'RENAME_PROJECT', payload: trimmed });
                setEditingName(false);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') { setNameInput(projectName); setEditingName(false); }
              }}
            />
          ) : (
            <span
              className="menu-project-name"
              title="Double-click to rename project"
              onDoubleClick={() => { setNameInput(projectName); setEditingName(true); }}
            >{projectName}</span>
          )}
        </div>

        {window.electronWindow && (
          <div className="window-controls">
            <button className="wc-btn wc-minimize" title="Minimize"
              onClick={() => window.electronWindow!.minimize()}>─</button>
            <button className="wc-btn wc-maximize" title="Maximize / Restore"
              onClick={() => window.electronWindow!.maximize()}>□</button>
            <button className="wc-btn wc-close" title="Close"
              onClick={() => window.electronWindow!.close()}>✕</button>
          </div>
        )}
      </div>

      {/* ── Local toast ── */}
      {localToast && (
        <div className="menu-local-toast">{localToast}</div>
      )}

      {/* ── Export progress overlay ── */}
      {exportProgress && (
        <div className="export-progress-overlay">
          <div className="export-progress-box">
            <div className="export-spinner" />
            <span>{exportProgress}</span>
          </div>
        </div>
      )}

      {/* ── About modal ── */}
      {showAbout && (
        <div className="menu-modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="menu-modal" onClick={e => e.stopPropagation()}>
            <h2 className="menu-modal-title">StudioDESK</h2>
            <p className="menu-modal-version">Version {__APP_VERSION__}</p>
            <p style={{ color: '#aaa', marginTop: 8 }}>
              Professional audio collaboration for recording engineers and artists.<br />
              Built with React 19, Electron 42, and WebRTC.
            </p>
            <p style={{ color: '#666', fontSize: 12, marginTop: 12 }}>
              © 2025 Shantel Bradford. All rights reserved.
            </p>
            <div className="menu-modal-footer">
              <button className="menu-modal-btn primary" onClick={() => setShowAbout(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Keyboard Shortcuts modal ── */}
      {showShortcuts && (
        <div className="menu-modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="menu-modal shortcuts-modal" onClick={e => e.stopPropagation()}>
            <h2 className="menu-modal-title">Keyboard Shortcuts</h2>
            <div className="shortcuts-table">
              {SHORTCUT_LIST.map(({ key, action }) => (
                <div key={key} className="shortcuts-row">
                  <kbd className="shortcut-key">{key}</kbd>
                  <span className="shortcut-action">{action}</span>
                </div>
              ))}
            </div>
            <div className="menu-modal-footer">
              <button className="menu-modal-btn primary" onClick={() => setShowShortcuts(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Notepad modal ── */}
      {showNotepad && (
        <div className="menu-modal-overlay" onClick={() => setShowNotepad(false)}>
          <div className="menu-modal notepad-modal" onClick={e => e.stopPropagation()}>
            <h2 className="menu-modal-title">Project Notepad</h2>
            <textarea
              className="notepad-textarea"
              value={notepadText}
              onChange={e => setNotepadText(e.target.value)}
              placeholder="Session notes, chord charts, lyrics, BPM, key…"
              rows={12}
            />
            <div className="menu-modal-footer">
              <button className="menu-modal-btn secondary" onClick={() => setShowNotepad(false)}>Cancel</button>
              <button className="menu-modal-btn primary" onClick={() => {
                localStorage.setItem('sd_notepad', notepadText);
                setShowNotepad(false);
                toast('Notepad saved.');
              }}>Save & Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Project Setup modal ── */}
      {showProjectSetup && (
        <div className="menu-modal-overlay" onClick={() => setShowProjectSetup(false)}>
          <div className="menu-modal project-setup-modal" onClick={e => e.stopPropagation()}>
            <h2 className="menu-modal-title">Project Setup</h2>
            <div className="project-setup-rows">
              <div className="setup-row">
                <label>Project Folder</label>
                <span className="setup-value">{projectName}</span>
              </div>
              <div className="setup-row">
                <label>Tempo (BPM)</label>
                <input
                  type="number"
                  className="setup-input"
                  value={projectTempo}
                  min={20} max={400}
                  onChange={e => setProjectTempo(parseInt(e.target.value) || state.transport.tempo)}
                />
              </div>
              <div className="setup-row">
                <label>Time Signature</label>
                <span className="setup-value">
                  {state.transport.timeSignature[0]}/{state.transport.timeSignature[1]}
                  &nbsp;—&nbsp;edit in Transport bar
                </span>
              </div>
              <div className="setup-row">
                <label>Audio Device</label>
                <span className="setup-value setup-link" onClick={() => { onOpenAudioPrefs?.(); setShowProjectSetup(false); }}>
                  Open Hardware Setup (F4) →
                </span>
              </div>
            </div>
            <div className="menu-modal-footer">
              <button className="menu-modal-btn secondary" onClick={() => setShowProjectSetup(false)}>Cancel</button>
              <button className="menu-modal-btn primary" onClick={() => {
                if (projectTempo >= 20 && projectTempo <= 400) {
                  dispatch({ type: 'SET_TEMPO', payload: projectTempo });
                }
                setShowProjectSetup(false);
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Project Length modal ── */}
      {showProjectLength && (
        <div className="menu-modal-overlay" onClick={() => setShowProjectLength(false)}>
          <div className="menu-modal project-setup-modal" onClick={e => e.stopPropagation()}>
            <h2 className="menu-modal-title">Project Length</h2>
            <div className="project-setup-rows">
              <div className="setup-row">
                <label>Minutes</label>
                <input
                  type="number"
                  className="setup-input"
                  value={projectLengthMin}
                  min={0} max={999}
                  onChange={e => setProjectLengthMin(Math.max(0, parseInt(e.target.value) || 0))}
                />
              </div>
              <div className="setup-row">
                <label>Seconds</label>
                <input
                  type="number"
                  className="setup-input"
                  value={projectLengthSec}
                  min={0} max={59}
                  onChange={e => setProjectLengthSec(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                />
              </div>
            </div>
            <div className="menu-modal-footer">
              <button className="menu-modal-btn secondary" onClick={() => setShowProjectLength(false)}>Cancel</button>
              <button className="menu-modal-btn primary" onClick={() => {
                const totalSec = projectLengthMin * 60 + projectLengthSec;
                localStorage.setItem('sd_projectLength', String(totalSec));
                dispatch({ type: 'SET_PROJECT_LENGTH', payload: totalSec });
                setShowProjectLength(false);
                toast(`Project length set to ${projectLengthMin}m ${projectLengthSec}s`);
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MenuBar;

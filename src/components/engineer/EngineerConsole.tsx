import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { DawProvider } from '../../context/DawContext';
import DawWorkspace from '../daw/DawWorkspace';
import FloatingVideoChat from '../daw/FloatingVideoChat';
import './EngineerConsole.css';

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'dashboard' | 'waiting' | 'connected' | 'daw-active';
type Tab   = 'sessions' | 'clients' | 'transfers' | 'settings';

interface ArtistPresence {
  user_id: string;
  role: string;
  display_name?: string;
}

interface Client {
  id: string;
  name: string;
  sessionCode?: string;
  sessions: number;
}

interface SessionHistoryEntry {
  code: string;
  createdAt: string; // ISO date string
}

interface Props {
  userId: string;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
}

// ─── Code generator ──────────────────────────────────────────────────────────

function generateSessionCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('') +
    '-' +
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function EngineerConsole({ userId, isAdmin, onOpenAdmin }: Props) {
  const [phase, setPhase] = useState<Phase>(() => {
    const room    = localStorage.getItem('sl_room');
    const granted = localStorage.getItem('sl_ec_granted');
    if (room && granted) return 'daw-active';
    if (room) return 'waiting';
    return 'dashboard';
  });
  const [roomCode, setRoomCode]                   = useState<string | null>(() => localStorage.getItem('sl_room'));
  const [artist, setArtist]                       = useState<ArtistPresence | null>(null);
  const [copied, setCopied]                       = useState(false);
  const [joinInput, setJoinInput]                 = useState('');
  const [dawControlGranted, setDawControlGranted] = useState(() => !!localStorage.getItem('sl_ec_granted'));
  const [activeTab, setActiveTab]                 = useState<Tab>('sessions');
  const [clients, setClients]                     = useState<Client[]>(() => {
    try { return JSON.parse(localStorage.getItem('sl_clients') ?? '[]'); }
    catch { return []; }
  });
  const [sessionHistory, setSessionHistory]       = useState<SessionHistoryEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem('sl_session_history') ?? '[]'); }
    catch { return []; }
  });
  const [showAddClient, setShowAddClient] = useState(false);
  const [newClient, setNewClient]         = useState({ name: '', sessionCode: '' });

  const phaseRef          = useRef(phase);
  const controlChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const nullStreamRef     = useRef<MediaStreamAudioDestinationNode | null>(null);
  const nullAudioCtxRef   = useRef<AudioContext | null>(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  useEffect(() => {
    localStorage.setItem('sl_clients', JSON.stringify(clients));
  }, [clients]);

  // ── Session lifecycle ───────────────────────────────────────────────────────

  const startSession = useCallback((code: string) => {
    setRoomCode(code);
    localStorage.setItem('sl_room', code);
    setPhase('waiting');
    setArtist(null);
    setDawControlGranted(false);
    setActiveTab('sessions');

    setSessionHistory(prev => {
      const entry: SessionHistoryEntry = { code, createdAt: new Date().toISOString() };
      const deduped = [entry, ...prev.filter(e => e.code !== code)].slice(0, 10);
      localStorage.setItem('sl_session_history', JSON.stringify(deduped));
      return deduped;
    });
  }, []);

  const endSession = useCallback(() => {
    localStorage.removeItem('sl_room');
    localStorage.removeItem('sl_ec_granted');
    setRoomCode(null);
    setArtist(null);
    setPhase('dashboard');
    setDawControlGranted(false);
  }, []);

  const copyCode = useCallback(() => {
    if (!roomCode) return;
    const doWrite = (): Promise<void> => {
      if (window.studioClipboard) return window.studioClipboard.write(roomCode);
      return navigator.clipboard.writeText(roomCode);
    };
    doWrite()
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })
      .catch(() => { setCopied(false); });
  }, [roomCode]);

  // ── Clients ───────────────────────────────────────────────────────────────

  const addClient = useCallback(() => {
    if (!newClient.name.trim()) return;
    const client: Client = {
      id: crypto.randomUUID(),
      name: newClient.name.trim(),
      sessionCode: newClient.sessionCode.trim().toUpperCase() || undefined,
      sessions: 0,
    };
    setClients(prev => [...prev, client]);
    setNewClient({ name: '', sessionCode: '' });
    setShowAddClient(false);
  }, [newClient]);

  const removeClient = useCallback((id: string) => {
    setClients(prev => prev.filter(c => c.id !== id));
  }, []);

  const clearSessionHistory = useCallback(() => {
    setSessionHistory([]);
    localStorage.removeItem('sl_session_history');
  }, []);

  const deleteSessionHistoryEntry = useCallback((code: string) => {
    setSessionHistory(prev => {
      const updated = prev.filter(e => e.code !== code);
      localStorage.setItem('sl_session_history', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // ── Presence: detect artist ────────────────────────────────────────────────

  useEffect(() => {
    if (!roomCode || phase === 'daw-active') return;

    const ch = supabase.channel(`daw-workspace-${roomCode}`, {
      config: { presence: { key: userId } },
    });

    ch.on('presence', { event: 'sync' }, () => {
      const presenceState = ch.presenceState();
      const all           = Object.values(presenceState).flat() as any[];
      const found         = all.find(p => p.user_id !== userId && p.role === 'artist');
      setArtist(found ?? null);

      const cur = phaseRef.current;
      if (found && cur === 'waiting') {
        setPhase('connected');
        setActiveTab('sessions');
      }
      if (!found && cur === 'connected') setPhase('waiting');
    });

    ch.subscribe(async status => {
      if (status === 'SUBSCRIBED') await ch.track({ user_id: userId, role: 'engineer' });
    });

    return () => { supabase.removeChannel(ch); };
  }, [roomCode, userId, phase]);

  // ── Control channel ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!roomCode) return;

    const ch = supabase.channel(`ec-session-${roomCode}`, {
      config: { broadcast: { ack: false } },
    });
    controlChannelRef.current = ch;

    ch.on('broadcast', { event: 'daw-control-granted' }, () => {
      // Artist granted DAW control via unified modal inside DawWorkspace
      localStorage.setItem('sl_ec_granted', JSON.stringify({
        dawControl: true,
        grantedAt: new Date().toISOString(),
        sessionId: roomCode,
      }));
      setDawControlGranted(true);
    });

    ch.on('broadcast', { event: 'daw-control-revoked' }, () => {
      localStorage.removeItem('sl_ec_granted');
      setDawControlGranted(false);
      setPhase(phaseRef.current === 'daw-active'
        ? (artist ? 'connected' : 'waiting')
        : phaseRef.current
      );
    });

    ch.subscribe();

    return () => {
      supabase.removeChannel(ch);
      controlChannelRef.current = null;
    };
  }, [roomCode, artist]);

  const enterDaw = useCallback(() => {
    setPhase('daw-active');
  }, []);

  // ── DAW-Active ─────────────────────────────────────────────────────────────

  const handleArtistLeft = useCallback(() => {
    localStorage.removeItem('sl_ec_granted');
    setDawControlGranted(false);
    setArtist(null);
    setPhase('waiting');
  }, []);

  const handleExitDawControl = useCallback(() => {
    localStorage.removeItem('sl_ec_granted');
    setDawControlGranted(false);
    controlChannelRef.current?.send({
      type: 'broadcast',
      event: 'daw-control-revoked',
      payload: {},
    }).catch(() => {});
    setPhase(artist ? 'connected' : 'waiting');
  }, [artist]);

  if (phase === 'daw-active' && roomCode) {
    return (
      <DawProvider userRole="engineer">
        <div className="app-container daw-mode">
          <DawWorkspace
            userRole="engineer"
            userId={userId}
            roomCode={roomCode}
            isAdmin={isAdmin}
            onOpenAdmin={onOpenAdmin}
            onArtistLeft={handleArtistLeft}
            onExitDawControl={handleExitDawControl}
            artistName={artist?.display_name}
          />
        </div>
      </DawProvider>
    );
  }

  const isInSession = phase !== 'dashboard';

  return (
    <div className="ec-root">
      <ConsoleNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isInSession={isInSession}
        phase={phase}
        onSignOut={async () => { await supabase.auth.signOut(); window.location.reload(); }}
      />

      <div className="ec-body">
        {activeTab === 'sessions' && (
          <>
            {phase === 'dashboard' && (
              <Dashboard
                joinInput={joinInput}
                onJoinInputChange={setJoinInput}
                onCreateSession={() => startSession(generateSessionCode())}
                onJoinSession={() => {
                  if (joinInput.replace('-', '').length >= 6) startSession(joinInput.toUpperCase());
                }}
                sessionHistory={sessionHistory}
                onReuseSession={startSession}
                onClearHistory={clearSessionHistory}
                onDeleteHistoryEntry={deleteSessionHistoryEntry}
              />
            )}
            {phase === 'waiting' && roomCode && (
              <WaitingRoom
                roomCode={roomCode}
                copied={copied}
                onCopy={copyCode}
                onEnd={endSession}
              />
            )}
            {phase === 'connected' && roomCode && (
              <StudioOverview
                roomCode={roomCode}
                artist={artist}
                dawControlGranted={dawControlGranted}
                onEnterDaw={enterDaw}
                onEnd={endSession}
              />
            )}
          </>
        )}

        {activeTab === 'clients' && (
          <ClientsPanel
            clients={clients}
            showAdd={showAddClient}
            newClient={newClient}
            onShowAdd={() => setShowAddClient(true)}
            onCancelAdd={() => { setShowAddClient(false); setNewClient({ name: '', sessionCode: '' }); }}
            onNewClientChange={setNewClient}
            onAddClient={addClient}
            onRemoveClient={removeClient}
          />
        )}

        {activeTab === 'transfers' && <TransfersPanel />}
        {activeTab === 'settings'  && <SettingsPanel  />}
      </div>

      {phase === 'connected' && roomCode && (
        <FloatingVideoChat
          userRole="engineer"
          userId={userId}
          roomCode={roomCode}
          masterStreamRef={nullStreamRef}
          audioCtxRef={nullAudioCtxRef}
        />
      )}
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'sessions',  label: 'Sessions'  },
  { id: 'clients',   label: 'Clients'   },
  { id: 'transfers', label: 'Transfers' },
  { id: 'settings',  label: 'Settings'  },
];

function ConsoleNav({
  activeTab, onTabChange, isInSession, phase, onSignOut,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  isInSession: boolean;
  phase: Phase;
  onSignOut: () => void;
}) {
  return (
    <nav className="ec-nav">
      <div className="ec-nav-brand">
        <span className="ec-brand-name">RiddimSync</span>
        <span className="ec-brand-pill">Engineer</span>
      </div>

      <div className="ec-nav-links">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`ec-nav-link ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {tab.id === 'sessions' && isInSession && <span className="ec-tab-dot" />}
          </button>
        ))}
      </div>

      <div className="ec-nav-right">
        {isInSession && (
          <div className="ec-status-indicator">
            <span className={`ec-status-dot ${phase === 'connected' ? 'green' : ''}`} />
            <span className="ec-status-text">
              {phase === 'waiting' ? 'Waiting for Artist' : 'Artist Connected'}
            </span>
          </div>
        )}
        <button className="ec-signout-btn" onClick={onSignOut}>Sign Out</button>
      </div>
    </nav>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({
  joinInput, onJoinInputChange, onCreateSession, onJoinSession,
  sessionHistory, onReuseSession, onClearHistory, onDeleteHistoryEntry,
}: {
  joinInput: string;
  onJoinInputChange: (v: string) => void;
  onCreateSession: () => void;
  onJoinSession: () => void;
  sessionHistory: SessionHistoryEntry[];
  onReuseSession: (code: string) => void;
  onClearHistory: () => void;
  onDeleteHistoryEntry: (code: string) => void;
}) {
  return (
    <div className="ec-dashboard">
      <div className="ec-dashboard-hero">
        <h1 className="ec-hero-title">Engineer Dashboard</h1>
        <p className="ec-hero-sub">Create a session and invite your artist to connect remotely.</p>
      </div>

      <div className="ec-session-cards">
        <div className="ec-card primary-card">
          <div className="ec-card-icon">＋</div>
          <h2 className="ec-card-title">New Session</h2>
          <p className="ec-card-desc">Generate a session ID and share it with your artist.</p>
          <button className="ec-btn primary" onClick={onCreateSession}>
            Create Session
          </button>
        </div>

        <div className="ec-card">
          <div className="ec-card-icon">→</div>
          <h2 className="ec-card-title">Join Session</h2>
          <p className="ec-card-desc">Enter an existing session ID to connect.</p>
          <div className="ec-join-row">
            <input
              className="ec-join-input"
              value={joinInput}
              onChange={e => onJoinInputChange(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && onJoinSession()}
              placeholder="XXXX-XXXX"
              maxLength={9}
              spellCheck={false}
            />
            <button
              className="ec-btn secondary"
              onClick={onJoinSession}
              disabled={joinInput.replace('-', '').length < 6}
            >
              Join
            </button>
          </div>
        </div>
      </div>

      {sessionHistory.length > 0 && (
        <div className="ec-history-section">
          <div className="ec-history-header">
            <h2 className="ec-history-title">Recent Sessions</h2>
            <button
              className="ec-btn ghost small danger"
              onClick={onClearHistory}
            >
              Clear History
            </button>
          </div>
          <div className="ec-history-list">
            {sessionHistory.map(entry => (
              <div key={entry.code} className="ec-history-row">
                <span className="ec-history-code">{entry.code}</span>
                <span className="ec-history-date">
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </span>
                <button
                  className="ec-btn ghost small ec-history-delete"
                  onClick={() => onDeleteHistoryEntry(entry.code)}
                  title="Remove"
                >
                  ×
                </button>
                <button
                  className="ec-btn secondary small ec-history-reuse"
                  onClick={() => onReuseSession(entry.code)}
                >
                  Reopen
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Waiting Room ─────────────────────────────────────────────────────────────

function WaitingRoom({
  roomCode, copied, onCopy, onEnd,
}: {
  roomCode: string;
  copied: boolean;
  onCopy: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="ec-center-wrap">
      <div className="ec-waiting-card">
        <div className="ec-waiting-anim">
          <span className="ec-pulse-ring" />
          <span className="ec-pulse-core" />
        </div>

        <h2 className="ec-section-title">Waiting for Artist</h2>
        <p className="ec-section-sub">Share this session ID with your artist to connect.</p>

        <div className="ec-session-id-block">
          <span className="ec-session-id-label">Session ID</span>
          <span className="ec-session-id-value">{roomCode}</span>
        </div>

        <div className="ec-waiting-actions">
          <button className="ec-btn primary" onClick={onCopy}>
            {copied ? '✓ Copied' : 'Copy Session ID'}
          </button>
          <button className="ec-btn ghost danger" onClick={onEnd}>
            End Session
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Studio Overview ──────────────────────────────────────────────────────────

function StudioOverview({
  roomCode, artist, dawControlGranted, onEnterDaw, onEnd,
}: {
  roomCode: string;
  artist: ArtistPresence | null;
  dawControlGranted: boolean;
  onEnterDaw: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="ec-so-wrap">
      <div className="ec-so-header">
        <div>
          <h1 className="ec-so-title">Studio Overview</h1>
          <p className="ec-so-subtitle">
            {artist
              ? 'Artist connected — enter the DAW to begin your session.'
              : 'Waiting for the artist to join.'}
          </p>
        </div>
        <div className="ec-so-session-badge">
          <span className="ec-so-session-label">Session</span>
          <span className="ec-so-session-code">{roomCode}</span>
        </div>
      </div>

      <div className="ec-so-grid">
        {/* Status panel */}
        <div className="ec-panel">
          <h3 className="ec-panel-title">Connection Status</h3>
          <div className="ec-status-list">
            <StatusRow label="Artist"          status={artist ? 'connected' : 'idle'}        detail={artist ? 'Connected' : 'Not joined'} />
            <StatusRow label="Engineer"        status="connected"                              detail="Connected" />
            <StatusRow label="DAW Control"     status={dawControlGranted ? 'connected' : 'idle'}
              detail={dawControlGranted ? 'Previously granted' : 'Request inside DAW'} />
            <StatusRow label="Desktop Control" status="idle"                                   detail="Request inside DAW" />
          </div>
        </div>

        {/* Actions panel */}
        <div className="ec-panel">
          <h3 className="ec-panel-title">Session Controls</h3>
          <div className="ec-action-list">
            <button
              className={`ec-action-btn ${artist ? 'primary' : 'secondary'}`}
              onClick={onEnterDaw}
              disabled={!artist}
            >
              <span className="ec-action-icon">⌨</span>
              <span>
                <strong>Enter DAW</strong>
                <small>
                  {artist
                    ? 'Open the remote studio — request access from within'
                    : 'Wait for artist to connect first'}
                </small>
              </span>
            </button>
          </div>

          <div className="ec-overview-end">
            <button className="ec-btn ghost danger small" onClick={onEnd}>
              End Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Clients ──────────────────────────────────────────────────────────────────

function ClientsPanel({
  clients, showAdd, newClient, onShowAdd, onCancelAdd, onNewClientChange, onAddClient, onRemoveClient,
}: {
  clients: Client[];
  showAdd: boolean;
  newClient: { name: string; sessionCode: string };
  onShowAdd: () => void;
  onCancelAdd: () => void;
  onNewClientChange: (c: { name: string; sessionCode: string }) => void;
  onAddClient: () => void;
  onRemoveClient: (id: string) => void;
}) {
  return (
    <div className="ec-tab-content">
      <div className="ec-content-header">
        <h2 className="ec-content-title">Clients</h2>
        {!showAdd && (
          <button className="ec-btn primary small" onClick={onShowAdd}>+ Add Client</button>
        )}
      </div>

      {showAdd && (
        <div className="ec-add-form">
          <div className="ec-add-form-fields">
            <input
              className="ec-form-input"
              placeholder="Artist Name *"
              value={newClient.name}
              onChange={e => onNewClientChange({ ...newClient, name: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && onAddClient()}
              autoFocus
            />
            <input
              className="ec-form-input"
              placeholder="Artist Session ID (e.g. XXXX-XXXX)"
              value={newClient.sessionCode}
              onChange={e => onNewClientChange({ ...newClient, sessionCode: e.target.value.toUpperCase() })}
              onKeyDown={e => e.key === 'Enter' && onAddClient()}
              maxLength={9}
            />
          </div>
          <div className="ec-form-actions">
            <button className="ec-btn primary small" onClick={onAddClient} disabled={!newClient.name.trim()}>
              Save Client
            </button>
            <button className="ec-btn ghost small" onClick={onCancelAdd}>Cancel</button>
          </div>
        </div>
      )}

      {clients.length === 0 && !showAdd && (
        <div className="ec-empty-state">
          <div className="ec-empty-icon">👤</div>
          <h3 className="ec-empty-title">No clients yet</h3>
          <p className="ec-empty-sub">Add your artists to keep track of their sessions.</p>
        </div>
      )}

      {clients.length > 0 && (
        <div className="ec-client-list">
          {clients.map(client => (
            <div key={client.id} className="ec-client-card">
              <div className="ec-client-avatar">{client.name.charAt(0).toUpperCase()}</div>
              <div className="ec-client-info">
                <strong className="ec-client-name">{client.name}</strong>
                {client.sessionCode && (
                  <div className="ec-client-details">
                    <span className="ec-client-session-code">ID: {client.sessionCode}</span>
                  </div>
                )}
              </div>
              <div className="ec-client-sessions">
                <span className="ec-session-count">{client.sessions}</span>
                <span className="ec-session-count-label">sessions</span>
              </div>
              <button
                className="ec-client-remove"
                onClick={() => onRemoveClient(client.id)}
                title="Remove client"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Transfers ────────────────────────────────────────────────────────────────

function TransfersPanel() {
  return (
    <div className="ec-tab-content">
      <div className="ec-content-header">
        <h2 className="ec-content-title">Transfers</h2>
      </div>
      <div className="ec-empty-state">
        <div className="ec-empty-icon">📁</div>
        <h3 className="ec-empty-title">File Transfer Center</h3>
        <p className="ec-empty-sub">
          Audio files recorded during sessions will appear here.<br />
          Start a session and record to begin tracking transfers.
        </p>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function SettingsPanel() {
  return (
    <div className="ec-tab-content">
      <div className="ec-content-header">
        <h2 className="ec-content-title">Settings</h2>
      </div>
      <div className="ec-empty-state">
        <div className="ec-empty-icon">⚙</div>
        <h3 className="ec-empty-title">Settings</h3>
        <p className="ec-empty-sub">Engineer preferences and configuration coming soon.</p>
      </div>
    </div>
  );
}

// ─── Shared: Status Row ───────────────────────────────────────────────────────

function StatusRow({
  label, status, detail,
}: {
  label: string;
  status: 'connected' | 'pending' | 'idle';
  detail?: string;
}) {
  return (
    <div className="ec-status-row">
      <span className={`ec-dot ${status}`} />
      <span className="ec-status-label">{label}</span>
      <span className={`ec-status-detail ${status}`}>{
        status === 'connected' ? (detail ?? 'Connected') :
        status === 'pending'   ? (detail ?? 'Pending…')  :
        (detail ?? 'Not active')
      }</span>
    </div>
  );
}

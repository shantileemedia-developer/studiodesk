import React, { useState, useEffect } from 'react';
import { Link2, Music, Key } from 'lucide-react';
import { claimArtistCode, type ArtistCode } from '../../lib/artistCodes';
import './SessionScreen.css';

const LAST_ROOM_KEY = 'studiolink_last_room';

interface SessionScreenProps {
  userRole: 'artist' | 'engineer';
  /** Pre-fetched artist code if the user already has one linked to their account */
  artistCode?: ArtistCode | null;
  onJoin: (roomCode: string) => void;
  /** Called when the artist successfully claims a new code for the first time */
  onArtistCodeClaimed?: (code: ArtistCode) => void;
}

const SessionScreen: React.FC<SessionScreenProps> = ({
  userRole, artistCode, onJoin, onArtistCodeClaimed,
}) => {
  const [generatedCode] = useState(() =>
    Math.random().toString(36).substring(2, 8).toUpperCase()
  );
  const [joinCode, setJoinCode]       = useState('');
  const [claimInput, setClaimInput]   = useState('');
  const [claimError, setClaimError]   = useState('');
  const [claimLoading, setClaimLoading] = useState(false);
  const [mode, setMode] = useState<'choose' | 'join'>(
    userRole === 'engineer' ? 'choose' : 'join'
  );

  useEffect(() => {
    const last = sessionStorage.getItem(LAST_ROOM_KEY);
    if (last) setJoinCode(last);
  }, []);

  const handleJoin = (code: string) => {
    sessionStorage.setItem(LAST_ROOM_KEY, code);
    onJoin(code);
  };

  const handleClaimCode = async () => {
    if (claimInput.length < 4) return;
    setClaimLoading(true);
    setClaimError('');
    try {
      const claimed = await claimArtistCode(claimInput);
      onArtistCodeClaimed?.(claimed);
      handleJoin(claimed.code);
    } catch (e: any) {
      setClaimError(e.message);
    } finally {
      setClaimLoading(false);
    }
  };

  // ── Engineer screens ──────────────────────────────────────────────────────

  if (mode === 'choose' && userRole === 'engineer') {
    return (
      <div className="session-container">
        <div className="session-card">
          <h2>Start a Session</h2>
          <p className="session-sub">Share this code with your artist to connect</p>
          <div className="session-code-box">{generatedCode}</div>
          <p className="session-hint">Both users must enter the same code</p>
          <button className="session-btn primary" onClick={() => handleJoin(generatedCode)}>
            <Link2 size={16} />
            Create Session
          </button>
          <button className="session-btn ghost" onClick={() => setMode('join')}>
            Join existing session
          </button>
          <SignOutButton />
        </div>
      </div>
    );
  }

  if (userRole === 'engineer') {
    return (
      <div className="session-container">
        <div className="session-card">
          <h2>Join a Session</h2>
          <p className="session-sub">Enter the session code</p>
          <input
            className="session-input"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            placeholder="XXXXXX"
            maxLength={8}
            autoFocus
          />
          <button
            className="session-btn primary"
            onClick={() => handleJoin(joinCode)}
            disabled={joinCode.length < 4}
          >
            <Link2 size={16} />
            Join Session
          </button>
          <button className="session-btn ghost" onClick={() => setMode('choose')}>
            Back
          </button>
          <SignOutButton />
        </div>
      </div>
    );
  }

  // ── Artist screen ─────────────────────────────────────────────────────────

  // Artist already has an assigned code → primary action is to go straight to DAW
  if (artistCode) {
    return (
      <div className="session-container">
        <div className="session-card">
          <div className="artist-code-badge">
            <Music size={20} color="#00ffcc" />
            <span>Your Artist Code</span>
          </div>
          <div className="session-code-box artist-code-box">{artistCode.code}</div>
          {artistCode.label && (
            <p className="session-hint" style={{ color: '#7c3aed', fontWeight: 600 }}>
              {artistCode.label}
            </p>
          )}
          <button className="session-btn primary" onClick={() => handleJoin(artistCode.code)}>
            <Music size={16} />
            Open My Studio
          </button>

          <div className="session-divider"><span>or join with a session code</span></div>

          <input
            className="session-input session-input-sm"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Engineer's code"
            maxLength={8}
          />
          <button
            className="session-btn ghost"
            onClick={() => handleJoin(joinCode)}
            disabled={joinCode.length < 4}
          >
            <Link2 size={16} />
            Join Engineer Session
          </button>

          <SignOutButton />
        </div>
      </div>
    );
  }

  // Artist has no code yet → offer to claim one or join by engineer code
  return (
    <div className="session-container">
      <div className="session-card">
        <h2>Welcome, Artist</h2>
        <p className="session-sub">
          Enter your Artist Code to work solo, or join an engineer's session.
        </p>

        {/* Claim an artist code */}
        <div className="claim-section">
          <div className="claim-label">
            <Key size={13} />
            <span>Artist Code (given to you by your studio)</span>
          </div>
          <div className="claim-row">
            <input
              className="session-input claim-input"
              value={claimInput}
              onChange={e => { setClaimInput(e.target.value.toUpperCase()); setClaimError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleClaimCode()}
              placeholder="BOLDMIC"
              maxLength={10}
            />
            <button
              className="session-btn primary claim-btn"
              onClick={handleClaimCode}
              disabled={claimInput.length < 4 || claimLoading}
            >
              {claimLoading ? '…' : 'Use Code'}
            </button>
          </div>
          {claimError && <p className="claim-error">{claimError}</p>}
        </div>

        <div className="session-divider"><span>or join with a session code from your engineer</span></div>

        <input
          className="session-input"
          value={joinCode}
          onChange={e => setJoinCode(e.target.value.toUpperCase())}
          placeholder="XXXXXX"
          maxLength={8}
        />
        <button
          className="session-btn ghost"
          onClick={() => handleJoin(joinCode)}
          disabled={joinCode.length < 4}
        >
          <Link2 size={16} />
          Join Session
        </button>

        <SignOutButton />
      </div>
    </div>
  );
};

const SignOutButton: React.FC = () => (
  <button
    className="session-btn ghost"
    style={{ marginTop: '12px', color: '#ff4d4d' }}
    onClick={async () => {
      const { supabase } = await import('../../lib/supabaseClient');
      await supabase.auth.signOut();
      window.location.reload();
    }}
  >
    Sign Out
  </button>
);

export default SessionScreen;

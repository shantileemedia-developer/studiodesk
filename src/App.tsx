import { useState, useEffect, lazy, Suspense } from 'react';
import './index.css';

import { supabase } from './lib/supabaseClient';
import { getMyArtistCode, type ArtistCode } from './lib/artistCodes';
import { DawProvider } from './context/DawContext';
import DawWorkspace from './components/daw/DawWorkspace';
import AuthScreen from './components/auth/AuthScreen';
import SessionScreen from './components/session/SessionScreen';
import LandingPage from './components/landing/LandingPage';

// Admin panel loaded lazily — not needed by most users
const AdminPanel = lazy(() => import('./components/admin/AdminPanel'));

const isElectron = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

function App() {
  const [showApp, setShowApp] = useState(() =>
    isElectron || localStorage.getItem('sl_showApp') === 'true'
  );
  const [showPinTip, setShowPinTip] = useState(() => {
    if (!isElectron) return false;
    const seen = localStorage.getItem('sl_pinTipSeen');
    if (!seen) { localStorage.setItem('sl_pinTipSeen', 'true'); return true; }
    return false;
  });
  const [userRole, setUserRole] = useState<'artist' | 'engineer' | null>(() =>
    (localStorage.getItem('sl_role') as 'artist' | 'engineer') || null
  );
  const [session, setSession] = useState<any>(null);
  const [roomCode, setRoomCode] = useState<string | null>(() =>
    localStorage.getItem('sl_room')
  );
  const [artistCode, setArtistCode] = useState<ArtistCode | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [passwordResetMode, setPasswordResetMode] = useState(false);

  // Re-validate Supabase session on mount + listen for PASSWORD_RECOVERY
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        const u = data.session.user;
        const meta = u.user_metadata ?? {};
        const isAdminUser = u.app_metadata?.is_admin === true;

        // Derive the canonical role from the session, not from localStorage.
        // localStorage can be stale (e.g. previous engineer session on same machine).
        let sessionRole = meta.role as 'artist' | 'engineer' | undefined;
        if (!sessionRole && isAdminUser) sessionRole = 'engineer';

        setSession(data.session);
        setIsAdmin(isAdminUser);

        if (sessionRole) {
          setUserRole(sessionRole);
          localStorage.setItem('sl_role', sessionRole);
        }

        if (sessionRole === 'artist') {
          getMyArtistCode(u.id).then(code => {
            if (code) {
              setArtistCode(code);
              setRoomCode(prev => {
                if (prev) return prev;
                localStorage.setItem('sl_room', code.code);
                return code.code;
              });
            }
          });
        }
      } else {
        localStorage.removeItem('sl_role');
        localStorage.removeItem('sl_room');
        setUserRole(null);
        setRoomCode(null);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordResetMode(true);
        setSession(null);
        setUserRole(null);
      } else if (event === 'SIGNED_OUT') {
        setSession(null);
        setUserRole(null);
        setIsAdmin(false);
        setRoomCode(null);
        setArtistCode(null);
        localStorage.removeItem('sl_role');
        localStorage.removeItem('sl_room');
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = (role: 'artist' | 'engineer', activeSession: any) => {
    setUserRole(role);
    setSession(activeSession);
    localStorage.setItem('sl_role', role);
    setIsAdmin(activeSession.user.app_metadata?.is_admin === true);

    if (role === 'artist') {
      getMyArtistCode(activeSession.user.id).then(code => {
        if (code) {
          setArtistCode(code);
          // Auto-join with artist code so they go straight to the DAW
          setRoomCode(code.code);
          localStorage.setItem('sl_room', code.code);
        }
      });
    }
  };

  const handleJoinSession = (code: string) => {
    setRoomCode(code);
    localStorage.setItem('sl_room', code);
  };

  // Called from SessionScreen when artist claims a new code
  const handleArtistCodeClaimed = (code: ArtistCode) => {
    setArtistCode(code);
    handleJoinSession(code.code);
  };

  const handleLaunchWeb = () => {
    setShowApp(true);
    localStorage.setItem('sl_showApp', 'true');
  };

  if (!showApp) {
    return (
      <LandingPage
        onLaunchWeb={handleLaunchWeb}
        exeDownloadUrl={`https://github.com/shantileemedia-developer/studiodesk/releases/download/v${__APP_VERSION__}/StudioDESK-Setup-${__APP_VERSION__}.exe`}
      />
    );
  }

  if (!session || !userRole) {
    return (
      <div className="app-container">
        <div className="top-bar">
          <div className="top-bar-title">StudioDESK</div>
        </div>
        <AuthScreen
          onLogin={(role, activeSession) => {
            setPasswordResetMode(false);
            handleLogin(role, activeSession);
          }}
          passwordResetMode={passwordResetMode}
        />
      </div>
    );
  }

  if (!roomCode) {
    return (
      <div className="app-container">
        <div className="top-bar">
          <div className="top-bar-title">
            StudioDESK — {userRole === 'engineer' ? 'Engineer' : 'Artist'}
          </div>
          {isAdmin && (
            <button
              className="top-bar-admin-btn"
              onClick={() => setShowAdminPanel(true)}
              title="Admin — Manage Artist Codes"
            >
              Admin
            </button>
          )}
        </div>
        <SessionScreen
          userRole={userRole}
          artistCode={artistCode}
          onJoin={handleJoinSession}
          onArtistCodeClaimed={handleArtistCodeClaimed}
        />
        {showAdminPanel && (
          <Suspense fallback={null}>
            <AdminPanel onClose={() => setShowAdminPanel(false)} />
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <DawProvider userRole={userRole}>
      <div className="app-container daw-mode">
        {showPinTip && (
          <div style={{
            position: 'fixed', top: 12, right: 12, zIndex: 9999,
            background: '#1e1e2e', border: '1px solid #7c3aed', borderRadius: 8,
            padding: '10px 14px', color: '#e2e8f0', fontSize: 13, maxWidth: 320,
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
          }}>
            <strong style={{ color: '#a78bfa' }}>Tip:</strong> Right-click the StudioDESK icon in your taskbar while the app is running, then choose <strong>Pin to taskbar</strong> for quick access.
            <button onClick={() => setShowPinTip(false)} style={{
              marginLeft: 10, background: 'none', border: 'none', color: '#94a3b8',
              cursor: 'pointer', fontSize: 16, lineHeight: 1, float: 'right',
            }}>×</button>
          </div>
        )}
        <DawWorkspace
          userRole={userRole}
          userId={session.user.id}
          roomCode={roomCode}
          isAdmin={isAdmin}
          onOpenAdmin={() => setShowAdminPanel(true)}
        />
        {showAdminPanel && (
          <Suspense fallback={null}>
            <AdminPanel onClose={() => setShowAdminPanel(false)} />
          </Suspense>
        )}
      </div>
    </DawProvider>
  );
}

export default App;

import { useState, useEffect } from 'react';
import './index.css';

import { supabase } from './lib/supabaseClient';
import { DawProvider } from './context/DawContext';
import DawWorkspace from './components/daw/DawWorkspace';
import AuthScreen from './components/auth/AuthScreen';
import SessionScreen from './components/session/SessionScreen';
import LandingPage from './components/landing/LandingPage';

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

  // On mount: re-validate Supabase session (handles page refresh and app restart)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setSession(data.session);
      } else {
        // Token expired — clear persisted state and drop back to auth
        localStorage.removeItem('sl_role');
        localStorage.removeItem('sl_room');
        setUserRole(null);
        setRoomCode(null);
      }
    });
  }, []);

  const handleLogin = (role: 'artist' | 'engineer', activeSession: any) => {
    setUserRole(role);
    setSession(activeSession);
    localStorage.setItem('sl_role', role);
  };

  const handleJoinSession = (code: string) => {
    setRoomCode(code);
    localStorage.setItem('sl_room', code);
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
        <AuthScreen onLogin={handleLogin} />
      </div>
    );
  }

  if (!roomCode) {
    return (
      <div className="app-container">
        <div className="top-bar">
          <div className="top-bar-title">StudioDESK — {userRole === 'engineer' ? 'Engineer' : 'Artist'}</div>
        </div>
        <SessionScreen userRole={userRole} onJoin={handleJoinSession} />
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
        />
      </div>
    </DawProvider>
  );
}

export default App;

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

function ElectronWindowControls() {
  if (!window.electronWindow) return null;
  return (
    <div className="app-wc">
      <button className="wc-btn wc-minimize" title="Minimize"
        onClick={() => window.electronWindow!.minimize()}>─</button>
      <button className="wc-btn wc-maximize" title="Maximize / Restore"
        onClick={() => window.electronWindow!.maximize()}>□</button>
      <button className="wc-btn wc-close" title="Close"
        onClick={() => window.electronWindow!.close()}>✕</button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <ElectronWindowControls />
  </StrictMode>,
)

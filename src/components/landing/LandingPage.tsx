import React from 'react';
import { Mic, Radio, Share2, Layers, Music, Download, Monitor } from 'lucide-react';
import './LandingPage.css';

interface LandingPageProps {
  onLaunchWeb: () => void;
  exeDownloadUrl?: string;
}

const LandingPage: React.FC<LandingPageProps> = ({ onLaunchWeb, exeDownloadUrl }) => {
  return (
    <div className="landing-container">
      {/* Dynamic Background */}
      <div className="landing-bg">
        <div className="blob blob-1"></div>
        <div className="blob blob-2"></div>
      </div>

      {/* Header */}
      <header className="landing-header">
        <div className="landing-logo">
          <div className="landing-logo-icon">
            <Radio size={20} color="#00ffcc" />
          </div>
          StudioDESK
        </div>
        <div className="landing-nav">
          <a href="#features">Features</a>
          <a href="#workflow">Workflow</a>
          <button className="nav-btn-primary" onClick={onLaunchWeb}>
            Open Web Studio
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="landing-main">
        <section className="hero-section">
          <div className="hero-content">
            <div className="hero-badge">Professional Audio Collaboration</div>
            <h1 className="hero-title">
              Your Studio, <br />
              <span className="text-gradient">Anywhere in the World.</span>
            </h1>
            <p className="hero-subtitle">
              StudioDESK connects recording engineers and artists in real-time. High-fidelity audio, seamless communication, and a Cubase-style workflow built for the modern internet.
            </p>
            
            <div className="hero-actions">
              <a
                href={exeDownloadUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                onClick={(e) => {
                  if (!exeDownloadUrl) {
                    e.preventDefault();
                    alert('The Windows installer is currently being built. Please check back in a moment!');
                  }
                }}
              >
                <Download size={20} />
                Download for Windows
              </a>
              <button className="btn btn-secondary" onClick={onLaunchWeb}>
                <Monitor size={20} />
                Launch Web App
              </button>
            </div>
            <div className="hero-platforms">
              Available for Windows & Web Browsers (Chrome/Edge recommended)
            </div>
            <div className="smartscreen-note">
              <strong>Windows users:</strong> If you see a SmartScreen warning, click <strong>"More info"</strong> then <strong>"Run anyway"</strong> — this is normal for new apps without a paid code certificate.
            </div>
          </div>
          
          <div className="hero-visual">
            <div className="glass-panel app-preview-container">
              <img src="/screenshot.png" alt="StudioDESK Interface" className="app-preview-img" />
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="features-section">
          <div className="section-heading">
            <h2>Built for Professionals</h2>
            <p>Everything you need to produce, record, and collaborate.</p>
          </div>
          
          <div className="features-grid">
            <div className="feature-card glass-panel">
              <div className="feature-icon"><Mic size={24} /></div>
              <h3>Pristine Audio Quality</h3>
              <p>Capture uncompressed, high-fidelity audio directly in your browser or desktop app with zero loss in quality.</p>
            </div>
            
            <div className="feature-card glass-panel">
              <div className="feature-icon"><Share2 size={24} /></div>
              <h3 className="text-cyan">Real-Time Sync</h3>
              <p>When the engineer presses record, the artist's transport rolls. Perfect synchronization across the globe.</p>
            </div>
            
            <div className="feature-card glass-panel">
              <div className="feature-icon"><Layers size={24} /></div>
              <h3>Cubase-Style Workflow</h3>
              <p>Familiar arrangement views, multi-track recording, and timeline grids you already know how to use.</p>
            </div>
            
            <div className="feature-card glass-panel">
              <div className="feature-icon"><Music size={24} /></div>
              <h3>Integrated Media Pool</h3>
              <p>Manage all your recorded takes and stems efficiently. Sync directly to your local file system on desktop.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="footer-content">
          <div className="footer-logo">StudioDESK</div>
          <div className="footer-links">
            <a href="https://github.com/shantileemedia-developer/studiodesk/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">Privacy Policy</a>
            <a href="https://github.com/shantileemedia-developer/studiodesk/blob/main/TERMS.md" target="_blank" rel="noreferrer">Terms of Service</a>
            <a href="mailto:shantelbridget93@gmail.com">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;

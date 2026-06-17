import React, { useState } from 'react';
import { Mic, Radio, Share2, Layers, Music, Download, Monitor, Video, MousePointer, UserCheck, Headphones, ArrowRight } from 'lucide-react';
import './LandingPage.css';

interface LandingPageProps {
  onLaunchWeb: () => void;
  exeDownloadUrl?: string;
}

const APP_VERSION = __APP_VERSION__;

const LandingPage: React.FC<LandingPageProps> = ({ onLaunchWeb, exeDownloadUrl }) => {
  const [screenshotError, setScreenshotError] = useState(false);

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
          RiddimSync
        </div>
        <div className="landing-nav">
          <a href="#roles">How It Works</a>
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
              RiddimSync connects recording engineers and artists in real-time. High-fidelity audio, seamless communication, and a Cubase-style workflow built for the modern internet.
            </p>

            <div className="hero-actions">
              <a
                href={exeDownloadUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                download="RiddimSync-Setup.exe"
                onClick={(e) => {
                  if (!exeDownloadUrl) {
                    e.preventDefault();
                    alert('The Windows installer is currently being built. Please check back in a moment!');
                  }
                }}
              >
                <Download size={20} />
                Download for Windows
                <span className="btn-version">v{APP_VERSION}</span>
              </a>
              <button className="btn btn-secondary" onClick={onLaunchWeb}>
                <Monitor size={20} />
                Launch Web App
              </button>
            </div>
            <div className="hero-platforms">
              Available for Windows &amp; Web Browsers (Chrome/Edge recommended)
            </div>
            <div className="smartscreen-note">
              <strong>Windows users:</strong> If you see a SmartScreen warning, click <strong>"More info"</strong> then <strong>"Run anyway"</strong> — this is normal for new apps without a paid code certificate.
            </div>
          </div>

          <div className="hero-visual">
            <div className="glass-panel app-preview-container">
              {screenshotError ? (
                <div className="app-preview-placeholder">
                  <Radio size={48} color="#00ffcc" opacity={0.4} />
                  <span>RiddimSync</span>
                </div>
              ) : (
                <img
                  src="/screenshot.png"
                  alt="RiddimSync Interface"
                  className="app-preview-img"
                  onError={() => setScreenshotError(true)}
                />
              )}
            </div>
          </div>
        </section>

        {/* Roles Section */}
        <section id="roles" className="roles-section">
          <div className="section-heading">
            <h2>Two Roles. One Session.</h2>
            <p>RiddimSync is built around the real-world studio relationship between engineer and artist.</p>
          </div>
          <div className="roles-grid">
            <div className="role-card glass-panel">
              <div className="role-icon engineer-icon">
                <UserCheck size={28} />
              </div>
              <h3>Recording Engineer</h3>
              <p>You run the session. Control the DAW, manage tracks, arm recording, set levels, and mix — all from your desktop. The artist hears everything in sync.</p>
              <ul className="role-features">
                <li>Full DAW control</li>
                <li>Multi-track recording &amp; editing</li>
                <li>Real-time transport sync to artist</li>
                <li>Remote control of artist's screen</li>
              </ul>
            </div>
            <div className="role-card glass-panel role-card-accent">
              <div className="role-icon artist-icon">
                <Headphones size={28} />
              </div>
              <h3>Artist</h3>
              <p>You focus on the performance. Hear playback through your headphones, watch the transport roll, and communicate with your engineer — no gear required beyond a mic.</p>
              <ul className="role-features">
                <li>Zero-setup audio capture</li>
                <li>Live transport feedback</li>
                <li>Video &amp; voice chat with engineer</li>
                <li>Works in any browser</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Workflow Section */}
        <section id="workflow" className="workflow-section">
          <div className="section-heading">
            <h2>A Session in Three Steps</h2>
            <p>No cables. No plugins. No installs for the artist.</p>
          </div>
          <div className="workflow-steps">
            <div className="workflow-step glass-panel">
              <div className="step-number">01</div>
              <h3>Engineer Creates a Room</h3>
              <p>Open RiddimSync on your desktop, log in as Engineer, and start a new session. You get a short room code to share with your artist.</p>
            </div>
            <div className="workflow-arrow">
              <ArrowRight size={24} color="#444" />
            </div>
            <div className="workflow-step glass-panel">
              <div className="step-number">02</div>
              <h3>Artist Joins from Any Browser</h3>
              <p>The artist opens RiddimSync in Chrome or Edge, enters the room code, and their audio stream is live — no downloads needed.</p>
            </div>
            <div className="workflow-arrow">
              <ArrowRight size={24} color="#444" />
            </div>
            <div className="workflow-step glass-panel">
              <div className="step-number">03</div>
              <h3>Press Record. Make Music.</h3>
              <p>The engineer arms the track and hits record. Both sides capture in sync. Review takes, edit clips, bounce stems — all inside RiddimSync.</p>
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
              <p>Familiar arrangement views, multi-track recording, mono &amp; stereo tracks, clip editing, and timeline grids you already know.</p>
            </div>

            <div className="feature-card glass-panel">
              <div className="feature-icon"><Music size={24} /></div>
              <h3>Integrated Media Pool</h3>
              <p>Manage all your recorded takes and stems efficiently. Sync directly to your local file system on desktop.</p>
            </div>

            <div className="feature-card glass-panel">
              <div className="feature-icon"><Video size={24} /></div>
              <h3>Built-In Video Chat</h3>
              <p>Stay face-to-face with your artist during the session. Floating video window stays out of your way while you work.</p>
            </div>

            <div className="feature-card glass-panel">
              <div className="feature-icon"><MousePointer size={24} /></div>
              <h3>Remote Control</h3>
              <p>Engineers can take control of the artist's screen to troubleshoot setup, adjust levels, or walk through the interface together.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="footer-content">
          <div className="footer-top">
            <div className="footer-logo">RiddimSync</div>
            <div className="footer-links">
              <a href="https://github.com/shantileemedia-developer/riddimSync/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">Privacy Policy</a>
              <a href="https://github.com/shantileemedia-developer/riddimSync/blob/main/TERMS.md" target="_blank" rel="noreferrer">Terms of Service</a>
              <a href="mailto:shantileemedia@gmail.com">Contact Support</a>
            </div>
          </div>
          <div className="footer-copy">© 2026 ShantiLee Media. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;

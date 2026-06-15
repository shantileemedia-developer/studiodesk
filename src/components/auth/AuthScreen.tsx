import React, { useState, useEffect } from 'react';
import { Mic, MonitorPlay, Activity, Eye, EyeOff, Lock } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { getMaskedEmailForCode, claimArtistCode } from '../../lib/artistCodes';
import { validateEngineerInvite } from '../../lib/engineerInvites';
import './AuthScreen.css';

interface AuthScreenProps {
  onLogin: (role: 'artist' | 'engineer', session: any) => void;
  passwordResetMode?: boolean;
}

type Screen =
  | 'signin'
  | 'signup-role'
  | 'signup-form'
  | 'forgot-password'
  | 'forgot-email'
  | 'forgot-code'
  | 'reset-password';

// ── Shared password field ─────────────────────────────────────────────────────

const PasswordField: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minLength?: number;
  label?: string;
  autoComplete?: string;
}> = ({ value, onChange, placeholder = '••••••••', minLength, label = 'Password', autoComplete }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="password-wrap">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          minLength={minLength}
          autoComplete={autoComplete}
          required
        />
        <button type="button" className="password-eye" onClick={() => setShow(v => !v)}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const AuthScreen: React.FC<AuthScreenProps> = ({ onLogin, passwordResetMode }) => {
  const [screen, setScreen]                     = useState<Screen>(passwordResetMode ? 'reset-password' : 'signin');
  const [signupRole, setSignupRole]             = useState<'artist' | 'engineer'>('artist');
  const [email, setEmail]                       = useState('');
  const [password, setPassword]                 = useState('');
  const [confirmPassword, setConfirmPassword]   = useState('');
  const [codeInput, setCodeInput]               = useState('');
  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState('');
  const [info, setInfo]                         = useState('');

  useEffect(() => {
    if (passwordResetMode) setScreen('reset-password');
  }, [passwordResetMode]);

  const resetForm = (next: Screen) => {
    setError(''); setInfo('');
    setEmail(''); setPassword(''); setConfirmPassword(''); setCodeInput('');
    setScreen(next);
  };

  // ── Sign In ────────────────────────────────────────────────────────────────

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setInfo('');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error('Sign in failed. Please try again.');
      const meta = data.session.user.user_metadata ?? {};
      let role = meta.role as 'artist' | 'engineer' | undefined;
      // Admin accounts created before role metadata was added — treat as engineer
      if (!role && data.session.user.app_metadata?.is_admin === true) role = 'engineer';
      if (!role) throw new Error('Account has no role. Contact your studio admin.');

      // Claim any artist code that was deferred because email confirmation was required
      if (role === 'artist' && meta.pending_artist_code) {
        try {
          await claimArtistCode(meta.pending_artist_code as string);
          await supabase.auth.updateUser({ data: { pending_artist_code: null } });
        } catch { /* already claimed or expired — proceed anyway */ }
      }

      onLogin(role, data.session);
    } catch (err: any) {
      setError(err.message || 'Sign in failed.');
    } finally { setLoading(false); }
  };

  // ── Artist Sign Up ────────────────────────────────────────────────────────

  const handleArtistSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (!codeInput.trim()) { setError('An artist code is required to create an account.'); return; }
    setLoading(true); setError('');
    try {
      const code = codeInput.toUpperCase().trim();

      // 1. Validate code + email match before touching auth
      const { data: valid } = await supabase.rpc('validate_artist_code_for_signup', {
        p_code: code,
        p_email: email.toLowerCase().trim(),
      });
      if (!valid) {
        throw new Error('That code wasn\'t issued to this email address, or it has already been claimed. Contact your studio admin.');
      }

      // 2. Create account — store code in metadata so it can be claimed after email confirmation
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { role: 'artist', pending_artist_code: code } },
      });
      if (error) throw error;
      if (!data.user) throw new Error('Sign up failed. Please try again.');

      if (data.session) {
        // Email confirmation is disabled — claim code and log in immediately
        await claimArtistCode(code);
        await supabase.auth.updateUser({ data: { pending_artist_code: null } });
        onLogin('artist', data.session);
      } else {
        // Email confirmation is required — let the user know
        setInfo('Account created! Check your email and click the confirmation link, then come back and sign in.');
        setScreen('signin');
      }
    } catch (err: any) {
      setError(err.message || 'Sign up failed.');
    } finally { setLoading(false); }
  };

  // ── Engineer Sign Up ──────────────────────────────────────────────────────

  const handleEngineerSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (!codeInput.trim()) { setError('An engineer invite code is required.'); return; }
    setLoading(true); setError('');
    try {
      // 1. Validate email + invite code
      const invited = await validateEngineerInvite(email, codeInput);
      if (!invited) {
        throw new Error('That invite code doesn\'t match this email address. Contact your studio admin.');
      }

      // 2. Create account
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { role: 'engineer' } },
      });
      if (error) throw error;
      if (!data.user) throw new Error('Sign up failed. Please try again.');

      if (data.session) {
        // Email confirmation disabled — log in immediately
        onLogin('engineer', data.session);
      } else {
        // Email confirmation required
        setInfo('Account created! Check your email and click the confirmation link, then come back and sign in.');
        setScreen('signin');
      }
    } catch (err: any) {
      setError(err.message || 'Sign up failed.');
    } finally { setLoading(false); }
  };

  // ── Forgot Password ────────────────────────────────────────────────────────

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setInfo('');
    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw error;
      setInfo(`Password reset link sent to ${email}. Check your inbox.`);
      setEmail('');
    } catch (err: any) {
      setError(err.message || 'Could not send reset email.');
    } finally { setLoading(false); }
  };

  // ── Forgot Email ──────────────────────────────────────────────────────────

  const handleForgotEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setInfo('');
    try {
      const masked = await getMaskedEmailForCode(codeInput);
      if (!masked) {
        setError('No account found for that code, or the code has already been claimed.');
      } else {
        setInfo(`The email linked to code ${codeInput.toUpperCase()} is: ${masked}`);
      }
    } catch (err: any) {
      setError(err.message);
    } finally { setLoading(false); }
  };

  // ── Forgot Code ───────────────────────────────────────────────────────────

  const handleForgotCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(''); setInfo('');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error('Sign in failed.');

      const { data: codeRow } = await supabase
        .from('artist_codes')
        .select('code')
        .eq('assigned_to', data.session.user.id)
        .maybeSingle();

      await supabase.auth.signOut();

      if (!codeRow) {
        setInfo('No artist code is linked to this account.');
      } else {
        setInfo(`Your artist code is: ${codeRow.code}`);
      }
    } catch (err: any) {
      setError(err.message || 'Could not retrieve your code.');
    } finally { setLoading(false); }
  };

  // ── Reset Password ────────────────────────────────────────────────────────

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setLoading(true); setError('');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setInfo('Password updated. You can now sign in.');
      setTimeout(() => resetForm('signin'), 2000);
    } catch (err: any) {
      setError(err.message || 'Could not update password.');
    } finally { setLoading(false); }
  };

  // ── Shared UI ─────────────────────────────────────────────────────────────

  const Brand = () => (
    <div className="auth-brand">
      <Activity size={28} color="#00ffcc" />
      <span>StudioDESK</span>
    </div>
  );

  const BackToSignIn = ({ label = 'Back to Sign In' }: { label?: string }) => (
    <div className="auth-footer">
      <button className="auth-link" onClick={() => resetForm('signin')}>{label}</button>
    </div>
  );

  const SupportFooter = () => (
    <div className="auth-support-footer">
      <a href="mailto:shantileemedia@gmail.com">Contact Support</a>
      <br />© 2026 ShantiLee Media. All rights reserved.
    </div>
  );

  // ── Reset Password ────────────────────────────────────────────────────────

  if (screen === 'reset-password') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <h2 className="auth-title">Set New Password</h2>
          {error && <div className="auth-error">{error}</div>}
          {info  && <div className="auth-info">{info}</div>}
          <form onSubmit={handleResetPassword} className="auth-form">
            <PasswordField value={password} onChange={setPassword}
              placeholder="New password (min 6)" minLength={6} autoComplete="new-password" />
            <PasswordField value={confirmPassword} onChange={setConfirmPassword}
              placeholder="Confirm new password" label="Confirm Password" autoComplete="new-password" />
            <button type="submit" className="auth-submit-btn" disabled={loading}>
              {loading ? 'Saving…' : 'Set New Password'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Forgot Password ───────────────────────────────────────────────────────

  if (screen === 'forgot-password') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <h2 className="auth-title">Reset Password</h2>
          <p className="auth-sub">Enter your email and we'll send a reset link.</p>
          {error && <div className="auth-error">{error}</div>}
          {info  && <div className="auth-info">{info}</div>}
          {!info && (
            <form onSubmit={handleForgotPassword} className="auth-form">
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@studio.com" autoFocus required />
              </div>
              <button type="submit" className="auth-submit-btn" disabled={loading}>
                {loading ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>
          )}
          <BackToSignIn />
        </div>
      </div>
    );
  }

  // ── Forgot Email ──────────────────────────────────────────────────────────

  if (screen === 'forgot-email') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <h2 className="auth-title">Forgot Email?</h2>
          <p className="auth-sub">Enter your artist code and we'll show the email it's registered to.</p>
          {error && <div className="auth-error">{error}</div>}
          {info  && <div className="auth-info">{info}</div>}
          {!info && (
            <form onSubmit={handleForgotEmail} className="auth-form">
              <div className="form-group">
                <label>Your Artist Code</label>
                <input
                  className="code-input-field"
                  value={codeInput}
                  onChange={e => { setCodeInput(e.target.value.toUpperCase()); setError(''); }}
                  placeholder="BOLDMIC"
                  maxLength={10}
                  autoFocus
                  required
                />
              </div>
              <button type="submit" className="auth-submit-btn" disabled={loading || codeInput.length < 4}>
                {loading ? 'Looking up…' : 'Find My Email'}
              </button>
            </form>
          )}
          {info && (
            <button className="auth-submit-btn" style={{ marginTop: 8 }} onClick={() => resetForm('signin')}>
              Go to Sign In
            </button>
          )}
          <BackToSignIn />
        </div>
      </div>
    );
  }

  // ── Forgot Code ───────────────────────────────────────────────────────────

  if (screen === 'forgot-code') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <h2 className="auth-title">Forgot Code?</h2>
          <p className="auth-sub">Sign in with your email and password to retrieve your artist code.</p>
          {error && <div className="auth-error">{error}</div>}
          {info  && <div className="auth-info">{info}</div>}
          {!info && (
            <form onSubmit={handleForgotCode} className="auth-form">
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@studio.com" autoFocus required />
              </div>
              <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
              <button type="submit" className="auth-submit-btn" disabled={loading}>
                {loading ? 'Looking up…' : 'Find My Code'}
              </button>
            </form>
          )}
          {info && (
            <button className="auth-submit-btn" style={{ marginTop: 8 }} onClick={() => resetForm('signin')}>
              Go to Sign In
            </button>
          )}
          <BackToSignIn />
        </div>
      </div>
    );
  }

  // ── Sign Up — role selection ───────────────────────────────────────────────

  if (screen === 'signup-role') {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <h2 className="auth-title">What's your role?</h2>
          <p className="auth-sub">This is set once and defines how you use the app.</p>
          <div className="role-cards">
            <button
              className={`role-card ${signupRole === 'artist' ? 'active' : ''}`}
              onClick={() => setSignupRole('artist')}
            >
              <Mic size={28} />
              <strong>Artist</strong>
              <span>Record, create, and work on your sessions. Requires an artist code from your studio admin.</span>
            </button>
            <button
              className={`role-card ${signupRole === 'engineer' ? 'active' : ''}`}
              onClick={() => setSignupRole('engineer')}
            >
              <MonitorPlay size={28} />
              <strong>Engineer</strong>
              <span>Connect remotely to an artist's session. Requires an invitation from your studio admin.</span>
            </button>
          </div>
          <button className="auth-submit-btn" onClick={() => setScreen('signup-form')}>
            Continue as {signupRole === 'artist' ? 'Artist' : 'Engineer'}
          </button>
          <div className="auth-footer">
            Already have an account?{' '}
            <button className="auth-link" onClick={() => resetForm('signin')}>Sign in</button>
          </div>
          <SupportFooter />
        </div>
      </div>
    );
  }

  // ── Sign Up — account form ────────────────────────────────────────────────

  if (screen === 'signup-form') {
    const isArtist = signupRole === 'artist';
    const handleSubmit = isArtist ? handleArtistSignUp : handleEngineerSignUp;

    return (
      <div className="auth-container">
        <div className="auth-card">
          <Brand />
          <div className="auth-role-pill">
            {isArtist ? <Mic size={13} /> : <MonitorPlay size={13} />}
            {isArtist ? 'Artist' : 'Engineer'}
            <button className="auth-link small" onClick={() => setScreen('signup-role')}>change</button>
          </div>
          <h2 className="auth-title">Create Account</h2>

          <div className="auth-invite-notice">
            <Lock size={12} />
            {isArtist
              ? 'An artist code is required. Contact your studio admin if you don\'t have one.'
              : 'An engineer invite code is required. Your studio admin will send it to you.'}
          </div>

          {error && <div className="auth-error">{error}</div>}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@studio.com" autoFocus required />
            </div>
            <PasswordField value={password} onChange={setPassword}
              placeholder="Min 6 characters" minLength={6} autoComplete="new-password" />
            <PasswordField value={confirmPassword} onChange={setConfirmPassword}
              placeholder="Re-enter password" label="Confirm Password" autoComplete="new-password" />

            <div className="form-group">
              <label>{isArtist ? 'Artist Code' : 'Invite Code'}</label>
              <input
                className="code-input-field"
                value={codeInput}
                onChange={e => { setCodeInput(e.target.value.toUpperCase()); setError(''); }}
                placeholder={isArtist ? 'BOLDMIC' : 'ACEDECK'}
                maxLength={12}
                required
              />
            </div>

            <button type="submit" className="auth-submit-btn" disabled={loading}>
              {loading ? 'Verifying…' : 'Create Account'}
            </button>
          </form>

          <div className="auth-footer">
            Already have an account?{' '}
            <button className="auth-link" onClick={() => resetForm('signin')}>Sign in</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Sign In ────────────────────────────────────────────────────────────────

  return (
    <div className="auth-container">
      <div className="auth-card">
        <Brand />
        <h2 className="auth-title">Sign In</h2>
        {info  && <div className="auth-info">{info}</div>}
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSignIn} className="auth-form">
          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@studio.com" autoFocus required />
          </div>
          <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
          <div className="auth-recovery-links">
            <button type="button" className="auth-link small" onClick={() => resetForm('forgot-password')}>
              Forgot password?
            </button>
            <button type="button" className="auth-link small" onClick={() => resetForm('forgot-email')}>
              Forgot email?
            </button>
            <button type="button" className="auth-link small" onClick={() => resetForm('forgot-code')}>
              Forgot code?
            </button>
          </div>
          <button type="submit" className="auth-submit-btn" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
        <div className="auth-footer">
          New to StudioDESK?{' '}
          <button className="auth-link" onClick={() => resetForm('signup-role')}>Create account</button>
        </div>
        <SupportFooter />
      </div>
    </div>
  );
};

export default AuthScreen;

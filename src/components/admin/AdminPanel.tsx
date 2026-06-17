import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Copy, Trash2, RefreshCw, CheckCircle, UserMinus, Mail, Settings, Eye, EyeOff } from 'lucide-react';
import {
  listAllCodes, createCode, updateCodeLabel, unassignCode, deleteCode,
  type ArtistCode,
} from '../../lib/artistCodes';
import {
  listEngineerInvites, createEngineerInvite, updateEngineerInviteLabel, deleteEngineerInvite,
  type EngineerInvite,
} from '../../lib/engineerInvites';
import './AdminPanel.css';

interface AdminPanelProps {
  onClose: () => void;
}

type Tab = 'artists' | 'engineers' | 'settings';

// true when running inside Electron
const isElectron = typeof (window as any).studioEmail !== 'undefined';

const email$ = isElectron ? (window as any).studioEmail : null;

const AdminPanel: React.FC<AdminPanelProps> = ({ onClose }) => {
  const [tab, setTab] = useState<Tab>('artists');

  // ── Artist codes ───────────────────────────────────────────────────────────

  const [codes, setCodes]               = useState<ArtistCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(true);
  const [codesError, setCodesError]     = useState('');
  const [copied, setCopied]             = useState<string | null>(null);
  const [mailed, setMailed]             = useState<string | null>(null);
  const [mailingId, setMailingId]       = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<{ id: string; value: string } | null>(null);
  const [newLabel, setNewLabel]         = useState('');
  const [newEmail, setNewEmail]         = useState('');

  // ── Engineer invites ───────────────────────────────────────────────────────

  const [invites, setInvites]               = useState<EngineerInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError]     = useState('');
  const [editingInviteLabel, setEditingInviteLabel] = useState<{ id: string; value: string } | null>(null);
  const [newInviteLabel, setNewInviteLabel] = useState('');
  const [newInviteEmail, setNewInviteEmail] = useState('');

  // ── Email settings ─────────────────────────────────────────────────────────

  const [emailConfigured, setEmailConfigured] = useState(false);
  const [gmailUser, setGmailUser]             = useState('');
  const [gmailPass, setGmailPass]             = useState('');
  const [showPass, setShowPass]               = useState(false);
  const [settingsSaving, setSettingsSaving]   = useState(false);
  const [settingsMsg, setSettingsMsg]         = useState('');

  // ── Load ───────────────────────────────────────────────────────────────────

  const loadCodes = useCallback(async () => {
    setCodesLoading(true); setCodesError('');
    try { setCodes(await listAllCodes()); }
    catch (e: any) { setCodesError(e.message); }
    finally { setCodesLoading(false); }
  }, []);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true); setInvitesError('');
    try { setInvites(await listEngineerInvites()); }
    catch (e: any) { setInvitesError(e.message); }
    finally { setInvitesLoading(false); }
  }, []);

  useEffect(() => {
    loadCodes();
    loadInvites();
    if (email$) email$.isConfigured().then(setEmailConfigured);
  }, [loadCodes, loadInvites]);

  // ── Artist code actions ────────────────────────────────────────────────────

  const handleCreateCode = async () => {
    try {
      const created = await createCode(newLabel, newEmail);
      setCodes(prev => [created, ...prev]);
      setNewLabel(''); setNewEmail('');
    } catch (e: any) { setCodesError(e.message); }
  };

  const handleCopy = (code: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code).catch(() => fallbackCopy(code));
    } else {
      fallbackCopy(code);
    }
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const handleSendArtistEmail = async (c: ArtistCode) => {
    if (!c.assigned_email) return;
    const subject = 'Your RiddimSync Artist Code';
    const body =
      `Hi${c.label ? ` ${c.label}` : ''},\n\n` +
      `Your RiddimSync Artist Code is:\n\n    ${c.code}\n\n` +
      `To get started:\n` +
      `1. Download or open RiddimSync\n` +
      `2. Create an account using this exact email address (${c.assigned_email})\n` +
      `3. On the signup form, enter your code above — it links permanently to your account\n\n` +
      `See you in the session.`;

    if (email$ && emailConfigured) {
      setMailingId(c.id);
      try {
        await email$.send(c.assigned_email, subject, body);
        setMailed(c.id);
        setTimeout(() => setMailed(null), 3000);
      } catch (e: any) {
        setCodesError(`Failed to send email: ${e.message}`);
      } finally { setMailingId(null); }
    } else {
      // Fallback: open email client
      window.open(`mailto:${c.assigned_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
      setMailed(c.id);
      setTimeout(() => setMailed(null), 3000);
    }
  };

  const handleSendEngineerEmail = async (inv: EngineerInvite) => {
    const subject = "You've been invited to RiddimSync";
    const body =
      `Hi${inv.label ? ` ${inv.label}` : ''},\n\n` +
      `You've been invited to join RiddimSync as an engineer.\n\n` +
      `Your invite code is:\n\n    ${inv.code}\n\n` +
      `To get started:\n` +
      `1. Download or open RiddimSync\n` +
      `2. Create an account using this exact email address (${inv.email})\n` +
      `3. Select the Engineer role and enter your invite code above\n\n` +
      `See you in the session.`;

    if (email$ && emailConfigured) {
      setMailingId(inv.id);
      try {
        await email$.send(inv.email, subject, body);
        setMailed(inv.id);
        setTimeout(() => setMailed(null), 3000);
      } catch (e: any) {
        setInvitesError(`Failed to send email: ${e.message}`);
      } finally { setMailingId(null); }
    } else {
      window.open(`mailto:${inv.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
      setMailed(inv.id);
      setTimeout(() => setMailed(null), 3000);
    }
  };

  const handleLabelSave = async (id: string) => {
    if (!editingLabel || editingLabel.id !== id) return;
    try {
      await updateCodeLabel(id, editingLabel.value);
      setCodes(prev => prev.map(c => c.id === id ? { ...c, label: editingLabel.value } : c));
    } catch (e: any) { setCodesError(e.message); }
    setEditingLabel(null);
  };

  const handleUnassign = async (id: string) => {
    try {
      await unassignCode(id);
      setCodes(prev => prev.map(c => c.id === id ? { ...c, assigned_to: null } : c));
    } catch (e: any) { setCodesError(e.message); }
  };

  const handleDeleteCode = async (id: string) => {
    if (!confirm('Delete this code? This cannot be undone.')) return;
    try {
      await deleteCode(id);
      setCodes(prev => prev.filter(c => c.id !== id));
    } catch (e: any) { setCodesError(e.message); }
  };

  // ── Engineer invite actions ────────────────────────────────────────────────

  const handleCreateInvite = async () => {
    try {
      const created = await createEngineerInvite(newInviteEmail, newInviteLabel);
      setInvites(prev => [created, ...prev]);
      setNewInviteLabel(''); setNewInviteEmail('');
    } catch (e: any) { setInvitesError(e.message); }
  };

  const handleInviteLabelSave = async (id: string) => {
    if (!editingInviteLabel || editingInviteLabel.id !== id) return;
    try {
      await updateEngineerInviteLabel(id, editingInviteLabel.value);
      setInvites(prev => prev.map(i => i.id === id ? { ...i, label: editingInviteLabel.value } : i));
    } catch (e: any) { setInvitesError(e.message); }
    setEditingInviteLabel(null);
  };

  const handleDeleteInvite = async (id: string) => {
    if (!confirm("Revoke this invite? If the engineer hasn't signed up yet, they won't be able to.")) return;
    try {
      await deleteEngineerInvite(id);
      setInvites(prev => prev.filter(i => i.id !== id));
    } catch (e: any) { setInvitesError(e.message); }
  };

  // ── Email settings actions ─────────────────────────────────────────────────

  const handleSaveEmailSettings = async () => {
    if (!email$) return;
    setSettingsSaving(true); setSettingsMsg('');
    try {
      await email$.configure(gmailUser.trim(), gmailPass.trim());
      setEmailConfigured(true);
      setGmailPass('');
      setSettingsMsg('Email configured successfully.');
    } catch (e: any) {
      setSettingsMsg(`Error: ${e.message}`);
    } finally { setSettingsSaving(false); }
  };

  const handleClearEmailSettings = async () => {
    if (!email$) return;
    await email$.clearConfig();
    setEmailConfigured(false);
    setGmailUser(''); setGmailPass('');
    setSettingsMsg('Email configuration removed.');
  };

  // ── Shared mail button renderer ────────────────────────────────────────────

  const MailButton = ({ id, onSend }: { id: string; onSend: () => void }) => {
    if (mailed === id) return (
      <span className="admin-mail-confirm"><CheckCircle size={13} color="#00ffcc" /> Sent</span>
    );
    return (
      <button className="admin-btn icon" title="Send email" disabled={mailingId === id} onClick={onSend}>
        {mailingId === id ? <RefreshCw size={14} className="spin" /> : <Mail size={14} />}
      </button>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="admin-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="admin-panel">

        <div className="admin-header">
          <div className="admin-header-left">
            <h2>Studio Admin</h2>
            <span className="admin-subtitle">
              Manage who can access RiddimSync. Artists need a code; engineers need an invite.
            </span>
          </div>
          <div className="admin-header-actions">
            <button className="admin-btn icon" onClick={() => { loadCodes(); loadInvites(); }} title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button className="admin-btn ghost close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="admin-tabs">
          <button className={`admin-tab ${tab === 'artists' ? 'active' : ''}`} onClick={() => setTab('artists')}>
            Artists <span className="admin-tab-count">{codes.length}</span>
          </button>
          <button className={`admin-tab ${tab === 'engineers' ? 'active' : ''}`} onClick={() => setTab('engineers')}>
            Engineers <span className="admin-tab-count">{invites.length}</span>
          </button>
          {isElectron && (
            <button className={`admin-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
              <Settings size={13} />
              Email
              {emailConfigured && <span className="admin-tab-dot" />}
            </button>
          )}
        </div>

        {/* ── Artists tab ── */}
        {tab === 'artists' && (
          <>
            <div className="admin-create-row">
              <input className="admin-input" placeholder="Artist name" value={newLabel}
                onChange={e => setNewLabel(e.target.value)} />
              <input className="admin-input" placeholder="artist@email.com" type="email"
                value={newEmail} onChange={e => setNewEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateCode()} />
              <button className="admin-btn primary" onClick={handleCreateCode} disabled={!newEmail.includes('@')}>
                <Plus size={15} /> Generate & Assign
              </button>
            </div>
            {codesError && <div className="admin-error">{codesError}</div>}
            {codesLoading ? (
              <div className="admin-loading">Loading codes…</div>
            ) : codes.length === 0 ? (
              <div className="admin-empty">No codes yet. Generate one above.</div>
            ) : (
              <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Code</th><th>Status</th><th>Added</th><th></th></tr>
                </thead>
                <tbody>
                  {codes.map(c => (
                    <tr key={c.id}>
                      <td className="col-email">
                        <span className="email-text">{c.assigned_email ?? <em className="label-empty">no email</em>}</span>
                      </td>
                      <td className="col-label">
                        {editingLabel?.id === c.id ? (
                          <input className="label-input" autoFocus value={editingLabel.value}
                            onChange={e => setEditingLabel({ id: c.id, value: e.target.value })}
                            onBlur={() => handleLabelSave(c.id)}
                            onKeyDown={e => { if (e.key === 'Enter') handleLabelSave(c.id); if (e.key === 'Escape') setEditingLabel(null); }} />
                        ) : (
                          <span className="label-text" onClick={() => setEditingLabel({ id: c.id, value: c.label })} title="Click to edit">
                            {c.label || <em className="label-empty">click to add name</em>}
                          </span>
                        )}
                      </td>
                      <td className="col-code">
                        <span className="code-pill">{c.code}</span>
                        <button className="admin-btn icon copy-btn" onClick={() => handleCopy(c.code)} title="Copy">
                          {copied === c.code ? <CheckCircle size={13} color="#00ffcc" /> : <Copy size={13} />}
                        </button>
                      </td>
                      <td className="col-status">
                        {c.assigned_to ? <span className="status-badge assigned">Claimed</span> : <span className="status-badge free">Available</span>}
                      </td>
                      <td className="col-date">{new Date(c.created_at).toLocaleDateString()}</td>
                      <td className="col-actions">
                        {c.assigned_email && !c.assigned_to && (
                          <MailButton id={c.id} onSend={() => handleSendArtistEmail(c)} />
                        )}
                        {c.assigned_to && (
                          <button className="admin-btn icon" onClick={() => handleUnassign(c.id)} title="Unassign">
                            <UserMinus size={14} />
                          </button>
                        )}
                        <button className="admin-btn icon danger" onClick={() => handleDeleteCode(c.id)} title="Delete">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </>
        )}

        {/* ── Engineers tab ── */}
        {tab === 'engineers' && (
          <>
            <div className="admin-create-row">
              <input className="admin-input" placeholder="Engineer name" value={newInviteLabel}
                onChange={e => setNewInviteLabel(e.target.value)} />
              <input className="admin-input" placeholder="engineer@email.com" type="email"
                value={newInviteEmail} onChange={e => setNewInviteEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateInvite()} />
              <button className="admin-btn primary" onClick={handleCreateInvite} disabled={!newInviteEmail.includes('@')}>
                <Plus size={15} /> Add Invite
              </button>
            </div>
            {invitesError && <div className="admin-error">{invitesError}</div>}
            {invitesLoading ? (
              <div className="admin-loading">Loading invites…</div>
            ) : invites.length === 0 ? (
              <div className="admin-empty">No engineer invites yet. Add an email above.</div>
            ) : (
              <div className="admin-table-wrap">
              <table className="admin-table engineers-table">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Code</th><th>Status</th><th>Added</th><th></th></tr>
                </thead>
                <tbody>
                  {invites.map(inv => (
                    <tr key={inv.id}>
                      <td className="col-email"><span className="email-text">{inv.email}</span></td>
                      <td className="col-label">
                        {editingInviteLabel?.id === inv.id ? (
                          <input className="label-input" autoFocus value={editingInviteLabel.value}
                            onChange={e => setEditingInviteLabel({ id: inv.id, value: e.target.value })}
                            onBlur={() => handleInviteLabelSave(inv.id)}
                            onKeyDown={e => { if (e.key === 'Enter') handleInviteLabelSave(inv.id); if (e.key === 'Escape') setEditingInviteLabel(null); }} />
                        ) : (
                          <span className="label-text" onClick={() => setEditingInviteLabel({ id: inv.id, value: inv.label })} title="Click to edit">
                            {inv.label || <em className="label-empty">click to add name</em>}
                          </span>
                        )}
                      </td>
                      <td className="col-code">
                        <span className="code-pill">{inv.code}</span>
                        <button className="admin-btn icon copy-btn" onClick={() => handleCopy(inv.code)} title="Copy">
                          {copied === inv.code ? <CheckCircle size={13} color="#00ffcc" /> : <Copy size={13} />}
                        </button>
                      </td>
                      <td className="col-status">
                        <span className="status-badge free">Invited</span>
                      </td>
                      <td className="col-date">{new Date(inv.created_at).toLocaleDateString()}</td>
                      <td className="col-actions">
                        <MailButton id={inv.id} onSend={() => handleSendEngineerEmail(inv)} />
                        <button className="admin-btn icon danger" onClick={() => handleDeleteInvite(inv.id)} title="Revoke">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </>
        )}

        {/* ── Email settings tab (Electron only) ── */}
        {tab === 'settings' && (
          <div className="admin-settings">
            <h3 className="admin-settings-title">Gmail Setup</h3>
            <p className="admin-settings-sub">
              Enter your Gmail address and an <strong>App Password</strong> (not your regular password).
              To get one: Google Account → Security → 2-Step Verification → App passwords.
            </p>

            {settingsMsg && (
              <div className={`admin-settings-msg ${settingsMsg.startsWith('Error') ? 'error' : 'success'}`}>
                {settingsMsg}
              </div>
            )}

            <div className="admin-settings-form">
              <div className="admin-settings-field">
                <label>Gmail Address</label>
                <input className="admin-input" type="email" placeholder="shantileemedia@gmail.com"
                  value={gmailUser} onChange={e => setGmailUser(e.target.value)} />
              </div>
              <div className="admin-settings-field">
                <label>App Password</label>
                <div className="admin-pass-wrap">
                  <input className="admin-input" type={showPass ? 'text' : 'password'}
                    placeholder="xxxx xxxx xxxx xxxx"
                    value={gmailPass} onChange={e => setGmailPass(e.target.value)} />
                  <button className="admin-pass-eye" onClick={() => setShowPass(v => !v)}>
                    {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              <div className="admin-settings-actions">
                <button className="admin-btn primary" onClick={handleSaveEmailSettings}
                  disabled={settingsSaving || !gmailUser.includes('@') || !gmailPass}>
                  {settingsSaving ? 'Saving…' : emailConfigured ? 'Update Credentials' : 'Save & Enable'}
                </button>
                {emailConfigured && (
                  <button className="admin-btn ghost" onClick={handleClearEmailSettings}>
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="admin-settings-status">
              Status:{' '}
              {emailConfigured
                ? <span className="status-badge assigned">Configured — emails send automatically</span>
                : <span className="status-badge free">Not configured — mail icon opens your email client</span>}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default AdminPanel;

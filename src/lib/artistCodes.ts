import { supabase } from './supabaseClient';

export interface ArtistCode {
  id: string;
  code: string;
  assigned_to: string | null;
  assigned_email: string | null;
  label: string;
  created_at: string;
}

// ── Readable code generation ──────────────────────────────────────────────────

const ADJECTIVES = [
  'BOLD','DARK','DEEP','EPIC','FAST','GOLD','HARD','JADE','KEEN','LOUD',
  'NEON','PURE','REAL','RICH','SILK','SLIM','SOFT','SOUL','STAR','TRUE',
  'WARM','WAVE','WILD','WIRE','ZERO',
];
const NOUNS = [
  'ARC','AXE','BAY','BOP','BUS','CUT','DAW','DIG','DIM','DUO',
  'FAD','FOG','GIG','HIT','HOP','HUE','JAM','KEY','LAB','LAP',
  'MIC','MIX','MOB','OHM','PAD','PAN','POP','RAW','RIG','RIM',
  'ROD','SAX','SKY','SON','SUB','TAP','TIN','VIP','WAX','ZAP',
];

/** Generate a human-readable 6–7 char code like BOLDMIC or EPICJAM. */
export function generateArtistCode(): string {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

// ── Artist API ────────────────────────────────────────────────────────────────

/** Returns the code already assigned to this user, or null. */
export async function getMyArtistCode(userId: string): Promise<ArtistCode | null> {
  const { data, error } = await supabase
    .from('artist_codes')
    .select('*')
    .eq('assigned_to', userId)
    .maybeSingle();
  if (error) { console.warn('[ArtistCodes] getMyArtistCode:', error.message); return null; }
  return data ?? null;
}

/**
 * Claim an unassigned code — links it to the current user's account.
 * Uses a SECURITY DEFINER RPC so regular artists can't bypass the update policy.
 * Throws a human-readable message if the code is invalid or already taken.
 */
export async function claimArtistCode(code: string): Promise<ArtistCode> {
  const { data, error } = await supabase
    .rpc('claim_artist_code', { p_code: code.toUpperCase().trim() })
    .single();
  if (error) {
    if (error.message.includes('EMAIL_MISMATCH'))
      throw new Error('This code was not issued to your email address.');
    if (error.message.includes('ALREADY_CLAIMED'))
      throw new Error('This code has already been claimed by another account.');
    if (error.message.includes('INVALID_CODE'))
      throw new Error('Code not found. Check the code and try again.');
    throw new Error(error.message);
  }
  return data as ArtistCode;
}

/**
 * Returns a masked email for an unclaimed code (e.g. sh***@gmail.com).
 * Safe to call without auth — used by the Forgot Email screen.
 */
export async function getMaskedEmailForCode(code: string): Promise<string | null> {
  const { data, error } = await supabase
    .rpc('get_masked_email_for_code', { p_code: code.toUpperCase().trim() });
  if (error) return null;
  return data as string | null;
}

// ── Admin API (requires app_metadata.is_admin = true) ────────────────────────

/** List all codes — assigned and unassigned. Admin only. */
export async function listAllCodes(): Promise<ArtistCode[]> {
  const { data, error } = await supabase
    .from('artist_codes')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Create a new code tied to an artist's email. Admin only. */
export async function createCode(label = '', email = ''): Promise<ArtistCode> {
  const code = generateArtistCode();
  const { data, error } = await supabase
    .from('artist_codes')
    .insert({
      code,
      label,
      assigned_email: email.trim().toLowerCase() || null,
      assigned_to: null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Update the label on an existing code. Admin only. */
export async function updateCodeLabel(id: string, label: string): Promise<void> {
  const { error } = await supabase
    .from('artist_codes')
    .update({ label })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Unassign a code so it can be given to someone else. Admin only. */
export async function unassignCode(id: string): Promise<void> {
  const { error } = await supabase
    .from('artist_codes')
    .update({ assigned_to: null })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Permanently delete a code. Admin only. */
export async function deleteCode(id: string): Promise<void> {
  const { error } = await supabase
    .from('artist_codes')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

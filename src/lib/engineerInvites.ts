import { supabase } from './supabaseClient';

export interface EngineerInvite {
  id: string;
  email: string;
  label: string;
  code: string;
  created_at: string;
}

const ADJECTIVES = [
  'ACE','AMP','ARC','BIG','BIT','BOX','CUE','DIM','DUB','ECO',
  'FLO','FLY','FOX','GEM','HEX','HIT','HOP','HOT','ICE','INK',
  'JET','KEY','LAB','LEX','LIT','MAX','MIX','MOD','NET','OHM',
  'OPT','ORB','PAD','PIX','PRO','RAW','RIG','RUN','SET','SKY',
  'SLY','SON','SYN','TAP','TEC','TOP','VIB','VOX','WAV','ZAP',
];
const NOUNS = [
  'BEAT','BEAM','CLIP','CORD','CRAT','CUBE','DASH','DECK','DESK','DIAL',
  'DISK','DOME','DOSE','DRUM','FEED','FLUX','FOLD','FREQ','GAIN','GATE',
  'GRID','HEAR','HOOK','JACK','KNOB','LANE','LEAD','LENS','LINK','LIVE',
  'LOCK','LOOP','MARK','MAST','MESH','MIDI','MODE','NODE','NOTE','PACK',
  'PEAK','PIPE','PLUG','PORT','RACK','RAIL','READ','RIFF','RISE','ROOT',
];

function generateEngineerCode(): string {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

/** Check if an email + code combination is valid. Safe to call without auth. */
export async function validateEngineerInvite(email: string, code: string): Promise<boolean> {
  const { data } = await supabase.rpc('validate_engineer_invite', {
    p_email: email.toLowerCase().trim(),
    p_code:  code.toUpperCase().trim(),
  });
  return data === true;
}

/** Admin: list all engineer invites. */
export async function listEngineerInvites(): Promise<EngineerInvite[]> {
  const { data, error } = await supabase
    .from('engineer_invites')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Admin: invite an engineer — generates a code automatically. */
export async function createEngineerInvite(email: string, label = ''): Promise<EngineerInvite> {
  const code = generateEngineerCode();
  const { data, error } = await supabase
    .from('engineer_invites')
    .insert({ email: email.toLowerCase().trim(), label, code })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Admin: update the label on an invite. */
export async function updateEngineerInviteLabel(id: string, label: string): Promise<void> {
  const { error } = await supabase
    .from('engineer_invites')
    .update({ label })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Admin: revoke an invite. */
export async function deleteEngineerInvite(id: string): Promise<void> {
  const { error } = await supabase
    .from('engineer_invites')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

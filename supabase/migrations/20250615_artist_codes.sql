-- Artist Codes System
-- Run in Supabase SQL Editor → Dashboard → SQL Editor → paste → Run
--
-- Admin users are identified by app_metadata.is_admin = true.
-- Set this in the Supabase dashboard:
--   Authentication → Users → click user → Edit → App Metadata:
--   { "is_admin": true }

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artist_codes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT        UNIQUE NOT NULL,          -- e.g. 'BOLDMIC'
  assigned_to  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  label        TEXT        NOT NULL DEFAULT '',      -- artist name / note (admin sets this)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE artist_codes ENABLE ROW LEVEL SECURITY;

-- ── Helper: is the current JWT an admin? ─────────────────────────────────────

CREATE OR REPLACE FUNCTION is_studio_admin()
RETURNS BOOLEAN
LANGUAGE SQL SECURITY DEFINER STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean,
    false
  );
$$;

-- ── Policies ─────────────────────────────────────────────────────────────────

-- Artists can read the code assigned to them; admins can read all
CREATE POLICY "artist_read_own_code"
  ON artist_codes FOR SELECT
  USING (auth.uid() = assigned_to OR is_studio_admin());

-- Only admins can insert new codes
CREATE POLICY "admin_insert"
  ON artist_codes FOR INSERT
  WITH CHECK (is_studio_admin());

-- Only admins can update codes (label, reassign)
CREATE POLICY "admin_update"
  ON artist_codes FOR UPDATE
  USING (is_studio_admin())
  WITH CHECK (is_studio_admin());

-- Only admins can delete codes
CREATE POLICY "admin_delete"
  ON artist_codes FOR DELETE
  USING (is_studio_admin());

-- ── Claim RPC ────────────────────────────────────────────────────────────────
-- Artists call this to self-assign an unassigned code.
-- Runs as SECURITY DEFINER so it can bypass the update policy safely.
-- Returns the code row on success, raises exception if code is invalid/already taken.

CREATE OR REPLACE FUNCTION claim_artist_code(p_code TEXT)
RETURNS artist_codes
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row artist_codes;
BEGIN
  -- Attempt to claim — only succeeds if code exists and is unassigned
  UPDATE artist_codes
  SET assigned_to = auth.uid()
  WHERE code = upper(trim(p_code))
    AND assigned_to IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'INVALID_OR_TAKEN'
      USING HINT = 'Code not found or already assigned to another account';
  END IF;

  RETURN v_row;
END;
$$;

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS artist_codes_assigned_to_idx ON artist_codes(assigned_to);
CREATE INDEX IF NOT EXISTS artist_codes_code_idx        ON artist_codes(code);

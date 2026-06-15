-- ── Artist code pre-signup validation ───────────────────────────────────────
-- Safe for anon to call — only returns boolean, no sensitive data exposed.
-- Used to validate code + email match BEFORE creating a Supabase account.

CREATE OR REPLACE FUNCTION validate_artist_code_for_signup(p_code TEXT, p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM artist_codes
    WHERE code            = upper(trim(p_code))
      AND assigned_to     IS NULL
      AND assigned_email  = lower(trim(p_email))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_artist_code_for_signup(TEXT, TEXT) TO anon, authenticated;

-- ── Engineer invites ──────────────────────────────────────────────────────────
-- Admin adds an email here; that email can then sign up as an engineer.
-- Once the account is created the email uniqueness in auth.users prevents reuse.

CREATE TABLE IF NOT EXISTS engineer_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        UNIQUE NOT NULL,
  label       TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only admins can read/write this table
ALTER TABLE engineer_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_engineer_invites"
  ON engineer_invites
  FOR ALL
  TO authenticated
  USING (is_studio_admin())
  WITH CHECK (is_studio_admin());

-- Anon-callable validation: returns true if email is in the invite list
CREATE OR REPLACE FUNCTION validate_engineer_invite(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM engineer_invites
    WHERE email = lower(trim(p_email))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_engineer_invite(TEXT) TO anon, authenticated;

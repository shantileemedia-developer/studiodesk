-- Add generated code to engineer invites (consistent with artist_codes)
ALTER TABLE engineer_invites ADD COLUMN IF NOT EXISTS code TEXT UNIQUE;

-- Backfill any existing rows with a placeholder (won't exist in prod yet)
UPDATE engineer_invites SET code = upper(substring(gen_random_uuid()::text, 1, 8)) WHERE code IS NULL;

ALTER TABLE engineer_invites ALTER COLUMN code SET NOT NULL;

-- Update validation to check both email AND code
CREATE OR REPLACE FUNCTION validate_engineer_invite(p_email TEXT, p_code TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  IF p_code IS NULL THEN
    -- Legacy: email-only check (fallback)
    RETURN EXISTS (SELECT 1 FROM engineer_invites WHERE email = lower(trim(p_email)));
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM engineer_invites
    WHERE email = lower(trim(p_email))
      AND code  = upper(trim(p_code))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_engineer_invite(TEXT, TEXT) TO anon, authenticated;

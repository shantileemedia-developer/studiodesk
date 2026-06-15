-- Add email pre-assignment to artist_codes
-- Run after 20250615_artist_codes.sql

ALTER TABLE artist_codes
  ADD COLUMN IF NOT EXISTS assigned_email TEXT;

-- Update the claim RPC to validate the email matches
CREATE OR REPLACE FUNCTION claim_artist_code(p_code TEXT)
RETURNS artist_codes
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row   artist_codes;
  v_email TEXT;
BEGIN
  -- Get the current user's email from the JWT
  v_email := auth.jwt() ->> 'email';

  -- Find the code
  SELECT * INTO v_row
  FROM artist_codes
  WHERE code = upper(trim(p_code));

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CODE'
      USING HINT = 'Code not found';
  END IF;

  IF v_row.assigned_to IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_CLAIMED'
      USING HINT = 'This code has already been claimed';
  END IF;

  -- If the code has an email restriction, enforce it
  IF v_row.assigned_email IS NOT NULL AND lower(v_row.assigned_email) <> lower(v_email) THEN
    RAISE EXCEPTION 'EMAIL_MISMATCH'
      USING HINT = 'This code was not issued to your email address';
  END IF;

  -- Claim it
  UPDATE artist_codes
  SET assigned_to = auth.uid()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

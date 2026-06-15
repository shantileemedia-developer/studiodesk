-- Public helper: returns a masked email for an unclaimed code
-- Used by the "Forgot Email" flow — safe to call without authentication.
-- Only works on unclaimed codes and never reveals the full email.

CREATE OR REPLACE FUNCTION get_masked_email_for_code(p_code TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
DECLARE
  v_email  TEXT;
  v_at     INT;
  v_local  TEXT;
  v_domain TEXT;
BEGIN
  SELECT assigned_email INTO v_email
  FROM artist_codes
  WHERE code = upper(trim(p_code))
    AND assigned_to IS NULL  -- only unclaimed codes can be hinted
    AND assigned_email IS NOT NULL;

  IF v_email IS NULL THEN RETURN NULL; END IF;

  -- Mask local part: first 2 chars + *** e.g. sh***@gmail.com
  v_at     := position('@' IN v_email);
  v_local  := substring(v_email FROM 1 FOR LEAST(2, v_at - 1)) || '***';
  v_domain := substring(v_email FROM v_at);

  RETURN v_local || v_domain;
END;
$$;

-- Allow the anon role to call this function
GRANT EXECUTE ON FUNCTION get_masked_email_for_code(TEXT) TO anon, authenticated;

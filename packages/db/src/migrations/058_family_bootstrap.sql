-- @supabase-only
-- 058 · Family bootstrap as a SECURITY DEFINER routine.
--
-- POST /api/family/bootstrap ran `INSERT INTO family (...) RETURNING ...` inside
-- the request's `authenticated` RLS transaction. The owner is not a family
-- member yet, so `family_select` (is_active_family_member, migration 053) hides
-- the row that INSERT just created: RETURNING comes back empty and the route
-- raises "family bootstrap did not return a family" -> HTTP 500. The follow-up
-- `INSERT INTO family_member` has the same shape of problem — the WITH CHECK in
-- `family_member_bootstrap_insert` reads `family` under that same SELECT policy.
--
-- Fix mirrors `activate_family_membership()` (053): one SECURITY DEFINER
-- function, EXECUTE granted to `authenticated`, that performs the privileged
-- write and returns the caller's resulting membership. The API layer still
-- decides WHO may call it (only FAMILY_OWNER_USER_ID) before invoking it; this
-- function only trusts that `auth.uid()` is a real signed-in user and that the
-- caller is not already in a family.

CREATE FUNCTION bootstrap_family(requested_name TEXT)
RETURNS TABLE (out_family_id UUID, out_name TEXT, out_role TEXT, out_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  clean_name TEXT := left(btrim(coalesce(requested_name, '')), 80);
  new_id UUID;
  new_name TEXT;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF clean_name = '' THEN
    clean_name := 'Keluarga Saya';
  END IF;

  -- Idempotent: an existing membership is returned untouched, so a retry after
  -- a client timeout does not error or rename anything.
  RETURN QUERY
  SELECT fm.family_id, f.name, fm.role, fm.status
    FROM family_member fm
    JOIN family f ON f.id = fm.family_id
   WHERE fm.user_id = caller;
  IF FOUND THEN
    RETURN;
  END IF;

  -- DO UPDATE (not DO NOTHING) so RETURNING always yields the row; the SET is a
  -- deliberate no-op that keeps an existing family's name if a prior attempt
  -- created the family but failed before the membership row.
  INSERT INTO family (name, created_by)
  VALUES (clean_name, caller)
  ON CONFLICT (created_by) DO UPDATE SET name = family.name
  RETURNING id, name INTO new_id, new_name;

  INSERT INTO family_member (family_id, user_id, role, status, joined_at)
  VALUES (new_id, caller, 'admin', 'active', now())
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY SELECT new_id, new_name, 'admin'::TEXT, 'active'::TEXT;
END
$$;

REVOKE ALL ON FUNCTION bootstrap_family(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_family(TEXT) TO authenticated;

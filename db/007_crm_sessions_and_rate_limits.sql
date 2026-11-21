-- 007_crm_sessions_and_rate_limits.sql
-- Server-side opaque sessions and distributed rate limits for Cloudflare Workers CRM

-- 1. crm_sessions table
CREATE TABLE IF NOT EXISTS public.crm_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.crm_businesses(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'worker')),
  kapso_assignee_id text,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  ttl timestamptz NOT NULL,
  revoked_at timestamptz DEFAULT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS: Only service_role can access crm_sessions
ALTER TABLE public.crm_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sessions_service_role ON public.crm_sessions;
CREATE POLICY crm_sessions_service_role ON public.crm_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_crm_sessions_lookup ON public.crm_sessions (id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_sessions_user ON public.crm_sessions (user_id);

-- 2. crm_rate_limits table
CREATE TABLE IF NOT EXISTS public.crm_rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 1,
  locked_until timestamptz DEFAULT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.crm_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_rate_limits_service_role ON public.crm_rate_limits;
CREATE POLICY crm_rate_limits_service_role ON public.crm_rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Atomic function to check and increment rate limit
CREATE OR REPLACE FUNCTION public.crm_check_rate_limit(
  p_key text,
  p_max_attempts integer DEFAULT 5,
  p_window_seconds integer DEFAULT 600,
  p_lockout_seconds integer DEFAULT 600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec record;
  v_now timestamptz := clock_timestamp();
  v_attempts integer := 1;
BEGIN
  SELECT attempts, locked_until, updated_at
    INTO v_rec
    FROM public.crm_rate_limits
   WHERE key = p_key
     FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.crm_rate_limits (key, attempts, locked_until, updated_at)
    VALUES (p_key, 1, NULL, v_now);
    RETURN jsonb_build_object('allowed', true, 'attempts', 1, 'remaining', p_max_attempts - 1);
  END IF;

  -- If currently locked out
  IF v_rec.locked_until IS NOT NULL AND v_rec.locked_until > v_now THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'attempts', v_rec.attempts,
      'retry_after', EXTRACT(EPOCH FROM (v_rec.locked_until - v_now))::integer
    );
  END IF;

  -- If window expired, reset attempts
  IF v_rec.updated_at < (v_now - (p_window_seconds || ' seconds')::interval) THEN
    UPDATE public.crm_rate_limits
       SET attempts = 1,
           locked_until = NULL,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'attempts', 1, 'remaining', p_max_attempts - 1);
  END IF;

  -- Otherwise increment
  v_attempts := v_rec.attempts + 1;
  IF v_attempts >= p_max_attempts THEN
    UPDATE public.crm_rate_limits
       SET attempts = v_attempts,
           locked_until = v_now + (p_lockout_seconds || ' seconds')::interval,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'attempts', v_attempts,
      'retry_after', p_lockout_seconds
    );
  ELSE
    UPDATE public.crm_rate_limits
       SET attempts = v_attempts,
           updated_at = v_now
     WHERE key = p_key;
    RETURN jsonb_build_object('allowed', true, 'attempts', v_attempts, 'remaining', p_max_attempts - v_attempts);
  END IF;
END;
$$;

-- Reset rate limit on successful login
CREATE OR REPLACE FUNCTION public.crm_reset_rate_limit(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.crm_rate_limits WHERE key = p_key;
END;
$$;

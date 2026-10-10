-- Fix: every unsubscribe link failed (APPLIED 2026-09-30 via the write connection).
--
-- unsubscribe_by_token returns TABLE(email text, …), so "email" is also an OUT
-- parameter inside the function. The unqualified `SELECT id, email, …` could
-- therefore mean either, and Postgres refused with
--   column reference "email" is ambiguous
-- The unsubscribe page showed that message for every token, valid or not, so
-- no reader could unsubscribe from the daily brief (a legal requirement for
-- marketing mail). Qualifying the columns removes the clash; the signature is
-- unchanged, so grants and the page's call stay as they are.
--
-- Verified: an invalid token now gets "Invalid unsubscribe link."; a real token
-- (tested inside a rolled-back transaction) returns the address and flips
-- email_subscribed.

CREATE OR REPLACE FUNCTION public.unsubscribe_by_token(p_token uuid)
 RETURNS TABLE(email text, already_unsubscribed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  target_id   uuid;
  target_email text;
  was_subscribed boolean;
BEGIN
  SELECT p.id, p.email, p.email_subscribed INTO target_id, target_email, was_subscribed
  FROM public.profiles p
  WHERE p.unsubscribe_token = p_token
  LIMIT 1;

  IF target_id IS NULL THEN
    RAISE EXCEPTION 'Invalid unsubscribe link.' USING ERRCODE = 'P0001';
  END IF;

  IF was_subscribed THEN
    UPDATE public.profiles AS pr SET email_subscribed = false WHERE pr.id = target_id;
  END IF;

  RETURN QUERY SELECT target_email, NOT was_subscribed;
END;
$function$;

-- Triggers on auth.users, copied from live by scripts/docker-local.mjs dump.
-- pg_dump leaves the auth schema out, so the baseline has the FUNCTIONS these call
-- (public/identity schema) but not the triggers themselves.
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

# Shared helpers for deploy/gcp/*.sh (sourced, not run).

# HS256 JWT with only openssl + coreutils (Cloud Shell has both).
#   mint_jwt <role> <secret> [years]   ->  header.payload.signature
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
mint_jwt() {
  local role="$1" secret="$2" years="${3:-5}"
  local now exp header payload sig
  now=$(date +%s)
  exp=$(( now + years * 365 * 86400 ))
  header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"iss":"attacked-api","role":"%s","iat":%d,"exp":%d}' "$role" "$now" "$exp" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

# URL-safe random strings for passwords and tokens.
rand_hex() { openssl rand -hex "${1:-24}"; }
rand_secret() { openssl rand -base64 64 | tr -d '\n=+/' | cut -c1-64; }

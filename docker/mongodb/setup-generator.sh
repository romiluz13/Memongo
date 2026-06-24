#!/bin/sh
set -eu

auth_dir="${AUTH_DIR:-/auth}"
template_dir="${TEMPLATE_DIR:-/templates}"
template_file="${MONGOT_TEMPLATE_FILE:-$template_dir/mongot.conf}"
generated_file="${MONGOT_GENERATED_FILE:-$auth_dir/mongot.generated.yml}"
provider_endpoint="${MONGOT_EMBEDDING_PROVIDER_ENDPOINT:-https://ai.mongodb.com/v1/embeddings}"

mongot_password="${MONGOT_PASSWORD:-mongotPassword}"
admin_password="${ADMIN_PASSWORD:-admin}"
query_key="${VOYAGE_API_QUERY_KEY:-${VOYAGE_API_KEY:-}}"
indexing_key="${VOYAGE_API_INDEXING_KEY:-${VOYAGE_API_KEY:-}}"
mongo_uid="${MONGODB_UID:-1000}"
mongo_gid="${MONGODB_GID:-1000}"

echo 'Setting up Memongo security files...'
mkdir -p "$auth_dir"
chmod 700 "$auth_dir" 2>/dev/null || true

ensure_openssl() {
  if command -v openssl >/dev/null 2>&1; then
    return 0
  fi
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssl >/dev/null 2>&1
    return 0
  fi
  echo 'openssl is required to generate the MongoDB keyfile' >&2
  exit 1
}

safe_chown() {
  chown "$mongo_uid:$mongo_gid" "$1" 2>/dev/null || true
}

safe_chown "$auth_dir"

if [ ! -f "$auth_dir/keyfile" ]; then
  echo 'Generating keyfile...'
  ensure_openssl
  openssl rand -base64 756 > "$auth_dir/keyfile"
  echo 'Keyfile generated successfully'
else
  echo 'Keyfile already exists, skipping'
fi
chmod 400 "$auth_dir/keyfile"
safe_chown "$auth_dir/keyfile"

printf '%s' "$mongot_password" > "$auth_dir/passwordFile"
chmod 600 "$auth_dir/passwordFile"
safe_chown "$auth_dir/passwordFile"
echo 'Password file created'

case "$provider_endpoint" in
  https://ai.mongodb.com/*)
    for key_name in VOYAGE_API_KEY VOYAGE_API_QUERY_KEY VOYAGE_API_INDEXING_KEY; do
      eval "key_value=\${$key_name:-}"
      if [ -n "$key_value" ] && [ "${key_value#al-}" = "$key_value" ]; then
        echo "$key_name must be an Atlas Model API key with the al-... prefix when using ai.mongodb.com" >&2
        exit 1
      fi
    done
    ;;
esac

if [ -n "$query_key" ]; then
  printf '%s' "$query_key" > "$auth_dir/voyage-api-query-key"
  chmod 600 "$auth_dir/voyage-api-query-key"
  safe_chown "$auth_dir/voyage-api-query-key"
  echo 'Query embedding key file created'
fi

if [ -n "$indexing_key" ]; then
  printf '%s' "$indexing_key" > "$auth_dir/voyage-api-indexing-key"
  chmod 600 "$auth_dir/voyage-api-indexing-key"
  safe_chown "$auth_dir/voyage-api-indexing-key"
  echo 'Indexing embedding key file created'
fi

cp "$template_file" "$generated_file"

if [ -n "$query_key" ] && [ -n "$indexing_key" ]; then
  cat >> "$generated_file" <<CONFIG

embedding:
   queryKeyFile: $auth_dir/voyage-api-query-key
   indexingKeyFile: $auth_dir/voyage-api-indexing-key
   providerEndpoint: $provider_endpoint
   isAutoEmbeddingViewWriter: true
CONFIG
  echo 'Embedded mongot auto-embedding configuration generated'
else
  echo 'No embedding API keys provided, generating mongot config without auto-embedding block'
fi

echo 'Setup complete.'

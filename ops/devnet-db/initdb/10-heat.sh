#!/usr/bin/env bash
# The devnet database's first start (#102): the image runs this once, as the `postgres` user, when its volume is empty.
# It makes what belongs to the server rather than to a database dump: the TLS certificate, the login role the Workers
# connect as, the database itself with Neon's locale, the pgvector extension and the operator app's role.
set -Eeuo pipefail

# Hyperdrive connects only over TLS. Workers VPC cannot trust a private CA yet, so the certificate is self-signed and the
# VPC service does not verify it: the tunnel carries the connection encrypted as far as cloudflared, whose last hop to
# this server is the compose network inside Docker's VM.
openssl req -new -x509 -days 3650 -nodes -subj "/CN=top-pad-devnet-db" \
  -keyout "$PGDATA/server.key" -out "$PGDATA/server.crt" 2>/dev/null
chmod 600 "$PGDATA/server.key"

app_password="$(<"$TOPPAD_PASSWORD_FILE")"

psql --no-psqlrc -v ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname=postgres \
  -v app_password="$app_password" <<'SQL'
-- Read when the entrypoint restarts the server after these scripts.
ALTER SYSTEM SET ssl = on;

-- The role the API and the operator app log in as, owner of every table, as on Neon.
CREATE ROLE toppad LOGIN PASSWORD :'app_password';

-- Neon's database exactly: UTF-8 with Postgres's builtin C.UTF-8 locale, which no libc version can change.
CREATE DATABASE toppad OWNER toppad TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8';

-- Migration 0016's role, which belongs to the server, so a restore's grants to it need it first; the connecting role may
-- SET it but does not inherit it, as 0016 grants it.
CREATE ROLE heat_operator NOLOGIN;
GRANT heat_operator TO toppad WITH INHERIT FALSE, SET TRUE;

\connect toppad
-- Made by the superuser, since the migrations' role may not create it (migration 0011 then finds it there).
CREATE EXTENSION vector;
SQL

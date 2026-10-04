#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/richardstenlund/hem-vardag.git"
INSTALL_DIR="${HEM_VARDAG_DIR:-/opt/hem-vardag}"
APP_PORT="${APP_PORT:-3010}"
die() { printf 'Fel: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Kör som root eller med sudo."
command -v apt-get >/dev/null || die "Snabbinstallationen kräver Debian/Ubuntu. Använd manuell installation på andra system."
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] || die "APP_PORT måste vara en giltig port."

if ! command -v git >/dev/null || ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y git curl ca-certificates
fi
if ! command -v docker >/dev/null; then
  DOCKER_SCRIPT="$(mktemp)"
  trap 'rm -f "$DOCKER_SCRIPT"' EXIT
  curl -fsSL https://get.docker.com -o "$DOCKER_SCRIPT"
  sh "$DOCKER_SCRIPT"
fi
docker compose version >/dev/null || die "Docker Compose v2 saknas."
docker info >/dev/null || die "Docker är inte igång. Starta tjänsten och försök igen."

if [ -d "$INSTALL_DIR/.git" ]; then
  [ "$(git -C "$INSTALL_DIR" remote get-url origin)" = "$REPO_URL" ] || die "Mappen tillhör ett annat projekt. Välj en annan HEM_VARDAG_DIR."
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

CREATED_ENV=0
if [ ! -f .env ]; then
  CREATED_ENV=1
  IP="$(hostname -I | awk '{print $1}')"
  secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
  ADMIN_USERNAME_VALUE="${ADMIN_USERNAME:-${ADMIN_EMAIL:-}}"
  ADMIN_PASSWORD_VALUE="${ADMIN_PASSWORD:-}"
  if [ -z "$ADMIN_USERNAME_VALUE" ] || [ -z "$ADMIN_PASSWORD_VALUE" ]; then
    [ -t 0 ] || die "Ange ADMIN_USERNAME och ADMIN_PASSWORD eller kör installationen i en interaktiv terminal."
    if [ -z "$ADMIN_USERNAME_VALUE" ]; then
      read -r -p "Administratörens användarnamn: " ADMIN_USERNAME_VALUE
    fi
    if [ -z "$ADMIN_PASSWORD_VALUE" ]; then
      read -r -s -p "Administratörens lösenord (minst 12 tecken): " ADMIN_PASSWORD_VALUE
      printf '\n'
      read -r -s -p "Upprepa lösenordet: " ADMIN_PASSWORD_CONFIRM
      printf '\n'
      [ "$ADMIN_PASSWORD_VALUE" = "$ADMIN_PASSWORD_CONFIRM" ] || die "Lösenorden stämmer inte överens."
    fi
  fi
  if ! { [[ "$ADMIN_USERNAME_VALUE" =~ ^[[:alnum:]åäöÅÄÖ._-]+$ ]] && [ "${#ADMIN_USERNAME_VALUE}" -ge 2 ] && [ "${#ADMIN_USERNAME_VALUE}" -le 64 ]; } && ! { [[ "$ADMIN_USERNAME_VALUE" =~ ^[^[:space:]]+@[^[:space:]]+\.[^[:space:]]+$ ]] && [ "${#ADMIN_USERNAME_VALUE}" -le 254 ]; }; then
    die "Ange ett användarnamn med 2–64 bokstäver, siffror, punkt, bindestreck eller understreck."
  fi
  [ "${#ADMIN_PASSWORD_VALUE}" -ge 12 ] && [ "${#ADMIN_PASSWORD_VALUE}" -le 256 ] || die "Adminlösenordet måste ha 12–256 tecken."
  [[ "$ADMIN_USERNAME_VALUE" != *\'* && "$ADMIN_USERNAME_VALUE" != *$'\n'* && "$ADMIN_USERNAME_VALUE" != *$'\r'* ]] || die "Användarnamnet får inte innehålla enkla citattecken eller radbrytningar."
  [[ "$ADMIN_PASSWORD_VALUE" != *\'* && "$ADMIN_PASSWORD_VALUE" != *$'\n'* && "$ADMIN_PASSWORD_VALUE" != *$'\r'* ]] || die "Adminlösenordet får inte innehålla enkla citattecken eller radbrytningar i snabbinstallationen. Använd manuell installation för sådana lösenord."
  APP_URL_VALUE="${APP_URL:-http://${IP:-localhost}:${APP_PORT}}"
  umask 077
  cat > .env <<EOF
ADMIN_USERNAME='${ADMIN_USERNAME_VALUE}'
ADMIN_PASSWORD='${ADMIN_PASSWORD_VALUE}'
DB_NAME=hemvardag
DB_USER=hemvardag
DB_PASSWORD=$(secret)
APP_PORT=${APP_PORT}
APP_URL=${APP_URL_VALUE}
APP_TIMEZONE=Europe/Stockholm
SESSION_DAYS=30
SECURE_COOKIES=false
ALLOW_REGISTRATION=true
EOF
else
  printf '.env finns redan och lämnas orörd.\n'
fi
get_env() { grep -m1 "^$1=" .env | cut -d= -f2-; }
PORT_VALUE="$(get_env APP_PORT)"
PORT_VALUE="${PORT_VALUE:-3010}"

docker compose up -d --build
READY=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health" >/dev/null; then READY=1; break; fi
  sleep 2
done
[ "$READY" -eq 1 ] || die "Webbappen svarar inte. Kör: cd $INSTALL_DIR && docker compose logs web db"
printf '\nHem & vardag är installerat!\nÖppna: %s\n' "$(get_env APP_URL)"
if [ "$CREATED_ENV" -eq 1 ]; then
  printf 'Administratören har skapats med dina valda uppgifter.\nNya konton får användarrollen. Administratörer kan ändra roller i kontohanteringen.\n'
fi
printf 'Uppdatera: cd %s && git pull --ff-only && docker compose up -d --build\n' "$INSTALL_DIR"

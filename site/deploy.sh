#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
case "$#" in
  0) ;;
  1) [[ "$1" == '--check' ]] || { echo 'Usage: deploy.sh [--check]' >&2; exit 2; } ;;
  *) echo 'Usage: deploy.sh [--check]' >&2; exit 2 ;;
esac
archive="${BROCO_SITE_ARCHIVE:-dist/site.tgz}"
test -s "$archive"
if [[ "${1:-}" == '--check' ]]; then
  tar -tzf "$archive" >/dev/null
  echo 'Verified prepared site archive. Local check only.'
  exit 0
fi
host="${BROCO_DEPLOY_HOST:?Set BROCO_DEPLOY_HOST for SSH deployment (for static CDNs, deploy site/dist/public directly).}"
domain="${BROCO_SITE_DOMAIN:?Set BROCO_SITE_DOMAIN}"
root="${BROCO_SITE_ROOT:-/srv/www/broco-site}"
resolve_ip="${BROCO_SITE_IP:-}"
probe_url="${BROCO_HEALTH_PROBE_URL:-}"
stage=$(ssh -o BatchMode=yes "$host" 'umask 077 && mktemp -d /var/tmp/broco-site.XXXXXXXX')
[[ $stage =~ ^/var/tmp/broco-site\.[A-Za-z0-9]+$ ]]
ssh "$host" "tar -xzf - -C $stage" < "$archive"
ssh "$host" bash -se -- "$stage" "$domain" "$root" "$resolve_ip" "$probe_url" <<'REMOTE'
set -euo pipefail
stage=$1
domain=$2
root=$3
resolve_ip=${4:-}
probe_url=${5:-}
old=$(readlink "$root/current")
[[ $old == releases/* && -s "$root/$old/index.html" ]]
stamp=$(date -u +%Y%m%d-%H%M%S)
backup=$(mktemp -d "/var/backups/broco-site-$stamp.XXXXXXXX")
release=$(mktemp -d "$root/releases/$stamp.XXXXXXXX")
cp -a "$stage/public/." "$release/"
chmod -R u=rwX,go=rX "$release"
test -s "$release/index.html"
swapped=0
restore() {
    local rc=$?
    if (( rc )); then
        set +e
        if (( swapped )); then ln -s "$old" "$release.rollback" && mv -Tf "$release.rollback" "$root/current"; fi
    fi
    return "$rc"
}
trap restore EXIT
ln -s "releases/$(basename "$release")" "$release.next"
mv -Tf "$release.next" "$root/current"
swapped=1
index_rc=0
resolve_args=()
if [[ -n "${resolve_ip:-}" ]]; then
    resolve_args=(--resolve "$domain:443:$resolve_ip")
fi
index_status=$(curl -sS --max-time 15 "${resolve_args[@]}" -o "$backup/live-index.html" -w '%{http_code}' "https://$domain/" 2>"$backup/live-index.err") || index_rc=$?
if (( index_rc )) || [[ "$index_status" != 200 ]]; then
    printf 'Site probe failed for https://%s/ (curl_rc=%d http=%s)\n' "$domain" "$index_rc" "${index_status:-000}" >&2
    cat "$backup/live-index.err" >&2
    head -c 1000 "$backup/live-index.html" >&2 || true
    exit 1
fi
if ! cmp -s "$release/index.html" "$backup/live-index.html"; then
    printf 'Deployed index.html diff against live https://%s/:\n' "$domain" >&2
    diff -u "$release/index.html" "$backup/live-index.html" >&2 || true
    exit 1
fi
health_url="${BROCO_HEALTH_PROBE_URL:-${probe_url:-https://$domain/docs/}}"
health_rc=0
health_status=$(curl -sS --max-time 15 "${resolve_args[@]}" -o "$backup/health.body" -w '%{http_code}' "$health_url" 2>"$backup/health.err") || health_rc=$?
if (( health_rc )) || [[ ! "$health_status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Health probe failed for %s (curl_rc=%d http=%s)\n' "$health_url" "$health_rc" "${health_status:-000}" >&2
    cat "$backup/health.err" >&2
    head -c 1000 "$backup/health.body" >&2 || true
    exit 1
fi
printf 'Verified %s\n' "$release"
REMOTE

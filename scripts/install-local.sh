#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX npm_config_local_prefix
if [ ! -x ui/node_modules/.bin/vite ]; then npm ci --prefix ui --no-audit --no-fund; fi
npm run build --prefix ui
packdir=$(mktemp -d)
trap 'rm -rf "$packdir"' EXIT
npm pack --pack-destination "$packdir" --silent
npm install --global --offline --no-audit --no-fund "$packdir"/*.tgz
clean_path=$(node -p "(process.env.PATH||'').split(':').filter(p=>p&&!/(\\/|^)(node_modules\\/\\.bin|\\.npm\\/_npx)(\\/|$)/.test(p)).join(':')")
PATH="$clean_path" "$(npm prefix -g)/bin/broco" setup

#!/usr/bin/env sh
set -eu
cd -- "$(dirname -- "$0")"
mkdir -p dist
stage=$(mktemp -d "$PWD/dist/build.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/public/assets/fonts" "$stage/public/assets/media"
expected="$stage/expected.list"
actual="$stage/actual.list"
cat > "$expected" <<'EOF'
public/assets/broco-favicon-192.png
public/assets/broco-favicon-32.png
public/assets/broco-favicon-64.png
public/assets/broco-foreman-256.png
public/assets/broco-social-preview-1280x640.png
public/assets/fonts/instrument-sans-latin.woff2
public/assets/fonts/jetbrains-mono-latin.woff2
public/assets/media/broco-demo-en-poster.jpg
public/assets/media/broco-demo-en.mp4
public/assets/media/broco-demo-preview-en.gif
public/assets/media/broco-demo-preview-zh.gif
public/assets/media/broco-demo-zh-poster.jpg
public/assets/media/broco-demo-zh.mp4
public/favicon.ico
public/index.html
public/install.ps1
public/install.sh
public/page.js
public/style.css
EOF
LC_ALL=C sort "$expected" -o "$expected"
find public ! -type d -print | LC_ALL=C sort > "$actual"
diff -u "$expected" "$actual"
while IFS= read -r rel; do
  file=${rel#public/}
  test -f "public/$file"
  test ! -L "public/$file"
  test -s "public/$file"
  cp "public/$file" "$stage/public/$file"
done < "$expected"
node ../docs-site/build.mjs "$stage/public"
node --check "$stage/public/page.js"
node --check "$stage/public/guide-assets/guide.js"
sh -n "$stage/public/install.sh"
if command -v dash >/dev/null 2>&1; then
  dash -n "$stage/public/install.sh"
fi
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -s sh "$stage/public/install.sh"
fi
if command -v pwsh >/dev/null 2>&1; then
  BROCO_PS1_CHECK="$stage/public/install.ps1" pwsh -NoLogo -NoProfile -NonInteractive -Command '$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:BROCO_PS1_CHECK,[ref]$null,[ref]$e); if($e.Count){$e | ForEach-Object{Write-Error $_.Message}; exit 1}'
fi
python3 check-links.py "$stage/public"
COPYFILE_DISABLE=1 tar -C "$stage" --no-xattrs -czf "$stage/site.tgz" public 2>/dev/null || COPYFILE_DISABLE=1 tar -C "$stage" -czf "$stage/site.tgz" public
rm -rf dist/public
mv "$stage/public" dist/public
mv "$stage/site.tgz" dist/site.tgz
echo 'Built site/dist/public and site/dist/site.tgz'

#!/bin/sh
set -eu

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13
MIN_NODE_PATCH=0
MIN_NODE_VERSION="${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}"
DEFAULT_NODE_MIRROR="https://nodejs.org/dist"
FALLBACK_NODE_MIRROR="https://npmmirror.com/mirrors/node"
DEFAULT_NPM_REGISTRY="https://registry.npmjs.org"
FALLBACK_NPM_REGISTRY="https://registry.npmmirror.com"
PACKAGE_NAME="@yanauto/broco"

TMP_DIR=""
EXTRACT_STAGE=""
RUNTIME_STAGE=""
APP_STAGE=""
APP_BACKUP=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
  if [ -n "$EXTRACT_STAGE" ] && [ -d "$EXTRACT_STAGE" ]; then
    rm -rf -- "$EXTRACT_STAGE"
  fi
  if [ -n "$RUNTIME_STAGE" ] && [ -d "$RUNTIME_STAGE" ]; then
    rm -rf -- "$RUNTIME_STAGE"
  fi
  if [ -n "$APP_STAGE" ] && [ -d "$APP_STAGE" ]; then
    rm -rf -- "$APP_STAGE"
  fi
}

trap cleanup EXIT INT TERM HUP

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'broco: %s\n' "$*" >&2
}

die() {
  printf 'broco: error: %s\n' "$1" >&2
  if [ $# -ge 2 ] && [ -n "$2" ]; then
    printf 'Next: %s\n' "$2" >&2
  fi
  exit 1
}

is_truthy() {
  case "${1:-}" in
    ""|0|false|FALSE|False|no|NO|No) return 1 ;;
    *) return 0 ;;
  esac
}

strip_trailing_slash() {
  val=$1
  while [ "$val" != "/" ]; do
    case "$val" in
      */) val=${val%/} ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$val"
}

resolve_abs_path() {
  raw=$1
  case "$raw" in
    /*) abs=$raw ;;
    *) abs="$PWD/$raw" ;;
  esac
  strip_trailing_slash "$abs"
}

resolve_existing_file() {
  raw=$1
  dir=$(dirname -- "$raw")
  base=$(basename -- "$raw")
  resolved_dir=$(cd -- "$dir" && pwd -P)
  printf '%s/%s\n' "$resolved_dir" "$base"
}

sh_quote() {
  escaped=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$escaped"
}

lower_ascii() {
  printf '%s' "$1" | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'
}

node_version_ok() {
  ver=${1#v}
  ver=${ver%%-*}
  maj=${ver%%.*}
  rest=${ver#*.}
  if [ "$rest" = "$ver" ]; then
    return 1
  fi
  min=${rest%%.*}
  pat=${rest#*.}
  if [ "$pat" = "$rest" ]; then
    pat=0
  fi
  pat=${pat%%.*}
  case "$maj$min$pat" in
    ""|*[!0-9]*) return 1 ;;
  esac
  if [ "$maj" -gt "$MIN_NODE_MAJOR" ]; then
    return 0
  fi
  if [ "$maj" -lt "$MIN_NODE_MAJOR" ]; then
    return 1
  fi
  if [ "$min" -gt "$MIN_NODE_MINOR" ]; then
    return 0
  fi
  if [ "$min" -lt "$MIN_NODE_MINOR" ]; then
    return 1
  fi
  [ "$pat" -ge "$MIN_NODE_PATCH" ]
}

is_musl_linux() {
  if [ "$PLATFORM" != "linux" ]; then
    return 1
  fi
  if command -v ldd >/dev/null 2>&1; then
    ldd_out=$(ldd --version 2>&1 || true)
    case "$ldd_out" in
      *musl*|*MUSL*) return 0 ;;
    esac
  fi
  for musl_ld in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
    if [ -e "$musl_ld" ]; then
      for glibc_ld in /lib64/ld-linux-*.so.* /lib/ld-linux-*.so.* /lib/*/ld-linux-*.so.*; do
        if [ -e "$glibc_ld" ]; then
          return 1
        fi
      done
      return 0
    fi
  done
  return 1
}

detect_platform() {
  os_raw=$(uname -s 2>/dev/null || printf 'unknown')
  case "$os_raw" in
    Darwin) PLATFORM="darwin" ;;
    Linux) PLATFORM="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Detected Windows shell ($os_raw)." "Run the Windows installer in PowerShell: irm https://broco.yanauto.me/install.ps1 | iex"
      ;;
    *)
      die "Unsupported operating system: $os_raw." "broco supports macOS, Linux (glibc), and Windows 11."
      ;;
  esac

  arch_raw=$(uname -m 2>/dev/null || printf 'unknown')
  case "$arch_raw" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
      die "Unsupported CPU architecture: $arch_raw (supported: x64, arm64)." "Install Node.js ${MIN_NODE_VERSION}+ manually and run: npm install -g ${PACKAGE_NAME}"
      ;;
  esac
}

download_file() {
  url=$1
  dest=$2
  max_sec=${3:-300}
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time "$max_sec" --retry 2 -o "$dest" "$url"
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" --timeout=30 --tries=2 "$url"
    return $?
  fi
  die "Neither curl nor wget is installed." "Install curl and rerun the installer."
}

sha256_file() {
  target=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$target" | awk '{print $NF}'
    return 0
  fi
  die "No SHA-256 verification tool found (expected sha256sum, shasum, or openssl)." "Install coreutils or openssl and rerun."
}

find_npm_for_node() {
  cand_node=$1
  cand_dir=$(dirname -- "$cand_node")
  if [ -x "$cand_dir/npm" ]; then
    NPM_BIN="$cand_dir/npm"
    NODE_DIR="$cand_dir"
    return 0
  fi
  if found_npm=$(command -v npm 2>/dev/null) && [ -x "$found_npm" ]; then
    NPM_BIN="$found_npm"
    NODE_DIR="$cand_dir"
    return 0
  fi
  return 1
}

try_reuse_node() {
  if [ "$FORCE_RUNTIME" -eq 1 ]; then
    return 1
  fi
  if path_node=$(command -v node 2>/dev/null) && [ -x "$path_node" ]; then
    path_ver=$("$path_node" -v 2>/dev/null || true)
    if node_version_ok "$path_ver" && find_npm_for_node "$path_node"; then
      NODE_BIN="$path_node"
      NODE_VER="$path_ver"
      return 0
    fi
  fi
  existing_node="$INSTALL_DIR/runtime/bin/node"
  if [ -x "$existing_node" ]; then
    existing_ver=$("$existing_node" -v 2>/dev/null || true)
    if node_version_ok "$existing_ver" && [ -x "$INSTALL_DIR/runtime/bin/npm" ]; then
      NODE_BIN="$existing_node"
      NODE_VER="$existing_ver"
      NPM_BIN="$INSTALL_DIR/runtime/bin/npm"
      NODE_DIR="$INSTALL_DIR/runtime/bin"
      return 0
    fi
  fi
  return 1
}

download_node_from_mirror() {
  mirror_base=$(strip_trailing_slash "$1")
  shasums_url="${mirror_base}/latest-v24.x/SHASUMS256.txt"
  shasums_file="${TMP_DIR}/SHASUMS256.txt"

  rm -f -- "$shasums_file"
  if ! download_file "$shasums_url" "$shasums_file" 30; then
    return 1
  fi

  suffix="-${PLATFORM}-${ARCH}.tar.gz"
  entry=$(awk -v suf="$suffix" '
    {
      sub(/\r$/, "")
    }
    NF == 2 && index($2, "node-v24.") == 1 && substr($2, length($2) - length(suf) + 1) == suf {
      print $1 " " $2
      exit
    }
  ' "$shasums_file")

  if [ -z "$entry" ]; then
    return 1
  fi

  expected_sha=$(lower_ascii "${entry%% *}")
  archive_name=${entry#* }

  case "$expected_sha" in
    *[!0-9a-f]*) return 1 ;;
  esac
  if [ "${#expected_sha}" -ne 64 ]; then
    return 1
  fi
  case "$archive_name" in
    */*|*..*) return 1 ;;
    node-v24.*-"${PLATFORM}"-"${ARCH}".tar.gz) ;;
    *) return 1 ;;
  esac

  archive_url="${mirror_base}/latest-v24.x/${archive_name}"
  archive_file="${TMP_DIR}/${archive_name}"
  rm -f -- "$archive_file"

  say "Downloading ${archive_name} from ${mirror_base}..."
  if ! download_file "$archive_url" "$archive_file"; then
    rm -f -- "$archive_file"
    return 1
  fi

  actual_sha=$(lower_ascii "$(sha256_file "$archive_file")")
  if [ "$actual_sha" != "$expected_sha" ]; then
    warn "SHA-256 mismatch for ${archive_name} from ${mirror_base}."
    rm -f -- "$archive_file"
    return 1
  fi

  if ! command -v tar >/dev/null 2>&1; then
    die "tar is required to extract Node.js." "Install tar and rerun."
  fi

  mkdir -p -- "$INSTALL_DIR"
  EXTRACT_STAGE="${INSTALL_DIR}/.extract.$$"
  rm -rf -- "$EXTRACT_STAGE"
  mkdir -p -- "$EXTRACT_STAGE"
  if ! tar -xzf "$archive_file" -C "$EXTRACT_STAGE"; then
    rm -rf -- "$EXTRACT_STAGE" "$archive_file"
    EXTRACT_STAGE=""
    return 1
  fi

  extracted_root="${EXTRACT_STAGE}/${archive_name%.tar.gz}"
  if [ ! -x "$extracted_root/bin/node" ] || [ ! -x "$extracted_root/bin/npm" ]; then
    rm -rf -- "$EXTRACT_STAGE" "$archive_file"
    EXTRACT_STAGE=""
    return 1
  fi

  RUNTIME_STAGE="${INSTALL_DIR}/.runtime.new.$$"
  rm -rf -- "$RUNTIME_STAGE"
  mv -- "$extracted_root" "$RUNTIME_STAGE"
  rm -rf -- "$EXTRACT_STAGE"
  EXTRACT_STAGE=""

  if [ -d "$INSTALL_DIR/runtime" ]; then
    runtime_old="${INSTALL_DIR}/.runtime.old.$$"
    rm -rf -- "$runtime_old"
    mv -- "$INSTALL_DIR/runtime" "$runtime_old"
    if ! mv -- "$RUNTIME_STAGE" "$INSTALL_DIR/runtime"; then
      mv -- "$runtime_old" "$INSTALL_DIR/runtime" || true
      die "Failed to update Node.js runtime in ${INSTALL_DIR}/runtime." "Check directory permissions and rerun."
    fi
    rm -rf -- "$runtime_old"
  else
    mv -- "$RUNTIME_STAGE" "$INSTALL_DIR/runtime"
  fi
  RUNTIME_STAGE=""

  NODE_BIN="$INSTALL_DIR/runtime/bin/node"
  NPM_BIN="$INSTALL_DIR/runtime/bin/npm"
  NODE_DIR="$INSTALL_DIR/runtime/bin"
  NODE_VER=$("$NODE_BIN" -v)
  return 0
}

ensure_node_runtime() {
  if try_reuse_node; then
    say "Using Node.js ${NODE_VER} (${NODE_BIN})"
    return 0
  fi

  if is_musl_linux; then
    die "Linux musl libc is not supported for bundled Node.js downloads." "Install Node.js ${MIN_NODE_VERSION}+ via your package manager (for example: apk add nodejs npm) and rerun."
  fi

  primary_mirror=$(strip_trailing_slash "${BROCO_NODE_MIRROR:-$DEFAULT_NODE_MIRROR}")
  if download_node_from_mirror "$primary_mirror"; then
    say "Installed private Node.js ${NODE_VER} into ${INSTALL_DIR}/runtime"
    return 0
  fi

  if [ "$primary_mirror" != "$FALLBACK_NODE_MIRROR" ]; then
    warn "Node.js download from ${primary_mirror} failed; retrying ${FALLBACK_NODE_MIRROR}..."
    if download_node_from_mirror "$FALLBACK_NODE_MIRROR"; then
      say "Installed private Node.js ${NODE_VER} into ${INSTALL_DIR}/runtime"
      return 0
    fi
  fi

  die "Could not download and verify Node.js 24 LTS." "Check network access, or set BROCO_NODE_MIRROR and rerun."
}

run_npm_install() {
  target_dir=$1
  pkg_spec=$2
  registry=$3

  rm -rf -- "$target_dir"
  mkdir -p -- "$target_dir"
  npm_cache="${TMP_DIR}/npm-cache"
  mkdir -p -- "$npm_cache"

  if [ -n "$registry" ]; then
    (
      unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX npm_config_local_prefix npm_config_global NPM_CONFIG_GLOBAL
      PATH="${NODE_DIR}:${PATH}" exec "$NPM_BIN" install --prefix "$target_dir" --cache "$npm_cache" --global=false --no-fund --no-audit --loglevel=error --registry "$registry" "$pkg_spec"
    )
    return $?
  fi

  (
    unset npm_config_prefix NPM_CONFIG_PREFIX PREFIX npm_config_local_prefix npm_config_global NPM_CONFIG_GLOBAL
    PATH="${NODE_DIR}:${PATH}" exec "$NPM_BIN" install --prefix "$target_dir" --cache "$npm_cache" --global=false --no-fund --no-audit --loglevel=error "$pkg_spec"
  )
}

install_broco_package() {
  mkdir -p -- "$INSTALL_DIR"
  APP_STAGE="${INSTALL_DIR}/.app.new.$$"

  if [ -n "$LOCAL_PACKAGE" ]; then
    if [ ! -f "$LOCAL_PACKAGE" ]; then
      die "BROCO_PACKAGE file not found: ${LOCAL_PACKAGE}." "Provide a valid .tgz path and rerun."
    fi
    pkg_spec=$(resolve_existing_file "$LOCAL_PACKAGE")
    say "Installing broco from ${pkg_spec}..."
    if ! run_npm_install "$APP_STAGE" "$pkg_spec" ""; then
      die "Failed to install broco from ${pkg_spec}." "Verify the tarball is valid and rerun."
    fi
  else
    pkg_spec="${PACKAGE_NAME}@${VERSION}"
    primary_reg=$(strip_trailing_slash "${BROCO_NPM_REGISTRY:-$DEFAULT_NPM_REGISTRY}")
    say "Installing ${pkg_spec}..."
    if ! run_npm_install "$APP_STAGE" "$pkg_spec" "$primary_reg"; then
      if [ "$primary_reg" != "$FALLBACK_NPM_REGISTRY" ]; then
        warn "npm install from ${primary_reg} failed; retrying ${FALLBACK_NPM_REGISTRY}..."
        if ! run_npm_install "$APP_STAGE" "$pkg_spec" "$FALLBACK_NPM_REGISTRY"; then
          die "Failed to install ${pkg_spec}." "Check network access, or set BROCO_NPM_REGISTRY and rerun."
        fi
      else
        die "Failed to install ${pkg_spec}." "Check network access, or set BROCO_NPM_REGISTRY and rerun."
      fi
    fi
  fi

  if [ ! -f "$APP_STAGE/node_modules/@yanauto/broco/bin/broco" ]; then
    die "Installed package is missing bin/broco." "Verify ${PACKAGE_NAME} version '${VERSION}' and rerun."
  fi

  if [ -d "$INSTALL_DIR/app" ]; then
    APP_BACKUP="${INSTALL_DIR}/.app.old.$$"
    rm -rf -- "$APP_BACKUP"
    mv -- "$INSTALL_DIR/app" "$APP_BACKUP"
    if ! mv -- "$APP_STAGE" "$INSTALL_DIR/app"; then
      mv -- "$APP_BACKUP" "$INSTALL_DIR/app" || true
      die "Failed to move broco into ${INSTALL_DIR}/app." "Check directory permissions and rerun."
    fi
    rm -rf -- "$APP_BACKUP"
    APP_BACKUP=""
  else
    mv -- "$APP_STAGE" "$INSTALL_DIR/app"
  fi
  APP_STAGE=""
}

write_shim() {
  mkdir -p -- "$INSTALL_DIR/bin" "$BIN_DIR"
  entry_script="$INSTALL_DIR/app/node_modules/@yanauto/broco/bin/broco"
  q_node=$(sh_quote "$NODE_BIN")
  q_entry=$(sh_quote "$entry_script")
  internal_shim="$INSTALL_DIR/bin/broco"
  shim_tmp="${INSTALL_DIR}/bin/.broco.new.$$"

  printf '#!/bin/sh\nexec %s %s "$@"\n' "$q_node" "$q_entry" > "$shim_tmp"
  chmod 755 "$shim_tmp"
  mv -- "$shim_tmp" "$internal_shim"

  bin_real=$(cd -- "$BIN_DIR" && pwd -P)
  internal_real=$(cd -- "$INSTALL_DIR/bin" && pwd -P)
  if [ "$bin_real" != "$internal_real" ]; then
    ln -sf "$internal_shim" "$BIN_DIR/broco"
  fi
  SHIM_PATH="$BIN_DIR/broco"
}

path_contains() {
  needle=$(strip_trailing_slash "$1")
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    if [ -n "$dir" ] && [ "$(strip_trailing_slash "$dir")" = "$needle" ]; then
      IFS=$old_ifs
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

guard_remove_path() {
  target=$1
  label=$2
  if [ -z "$target" ] || [ "$target" = "/" ]; then
    die "Refusing to remove unsafe ${label} path: '${target}'." "Set BROCO_INSTALL_DIR to a dedicated directory."
  fi
  if [ -n "${HOME:-}" ]; then
    home_clean=$(strip_trailing_slash "$HOME")
    if [ "$target" = "$home_clean" ]; then
      die "Refusing to remove your home directory (${target})." "Set BROCO_INSTALL_DIR to a dedicated subdirectory."
    fi
  fi
}

do_uninstall() {
  guard_remove_path "$INSTALL_DIR" "install"

  shim_candidate="$BIN_DIR/broco"
  if [ -L "$shim_candidate" ]; then
    link_target=$(readlink "$shim_candidate" 2>/dev/null || true)
    case "$link_target" in
      "$INSTALL_DIR"|"$INSTALL_DIR"/*)
        rm -f -- "$shim_candidate"
        ;;
    esac
  elif [ -f "$shim_candidate" ]; then
    if grep -Fq "$INSTALL_DIR/app/node_modules/@yanauto/broco" "$shim_candidate" 2>/dev/null; then
      rm -f -- "$shim_candidate"
    fi
  fi

  if [ -e "$INSTALL_DIR" ]; then
    rm -rf -- "$INSTALL_DIR"
  fi

  data_dir=$(resolve_abs_path "${BROCO_HOME:-$HOME/.broco}")
  if [ "$PURGE" -eq 1 ]; then
    guard_remove_path "$data_dir" "data"
    if [ -e "$data_dir" ]; then
      rm -rf -- "$data_dir"
    fi
    say "Uninstalled broco and removed data at ${data_dir}."
  else
    say "Uninstalled broco from ${INSTALL_DIR}."
    say "Kept data in ${data_dir} (pass --purge to remove it)."
  fi
}

print_usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --version <ver>   Install a specific @yanauto/broco version or dist-tag
  --no-setup        Skip running broco setup after installation
  --uninstall       Remove broco install directory and shim
  --purge           Also remove ~/.broco data (requires --uninstall)
  -h, --help        Show this help message

Environment variables:
  BROCO_INSTALL_DIR     Install root (default: ~/.local/share/broco)
  BROCO_BIN_DIR         Shim directory (default: ~/.local/bin)
  BROCO_VERSION         Package version or dist-tag (default: latest)
  BROCO_NODE_MIRROR     Node.js dist base URL (default: https://nodejs.org/dist)
  BROCO_NPM_REGISTRY    npm registry URL (default: https://registry.npmjs.org)
  BROCO_FORCE_RUNTIME=1 Always download private Node.js 24 LTS runtime
  BROCO_NO_SETUP=1      Skip running broco setup after installation
  BROCO_PACKAGE         Path to a local .tgz package
  BROCO_UNINSTALL=1     Uninstall broco
  BROCO_PURGE=1         With uninstall, also remove ~/.broco data
EOF
}

is_interactive_tty() {
  if [ ! -t 1 ]; then
    return 1
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    return 1
  fi
  ( : < /dev/tty ) 2>/dev/null
}

main() {
  UNINSTALL=0
  PURGE=0
  NO_SETUP=0
  VERSION="${BROCO_VERSION:-latest}"
  FORCE_RUNTIME=0
  LOCAL_PACKAGE="${BROCO_PACKAGE:-}"

  if is_truthy "${BROCO_UNINSTALL:-}"; then
    UNINSTALL=1
  fi
  if is_truthy "${BROCO_PURGE:-}"; then
    PURGE=1
  fi
  if is_truthy "${BROCO_NO_SETUP:-}"; then
    NO_SETUP=1
  fi
  if is_truthy "${BROCO_FORCE_RUNTIME:-}"; then
    FORCE_RUNTIME=1
  fi

  while [ $# -gt 0 ]; do
    case "$1" in
      --uninstall) UNINSTALL=1 ;;
      --purge) PURGE=1 ;;
      --no-setup) NO_SETUP=1 ;;
      --version)
        shift
        if [ $# -eq 0 ] || [ -z "$1" ]; then
          die "Missing value for --version." "Pass a version or dist-tag, for example: --version latest"
        fi
        VERSION=$1
        ;;
      --version=*)
        VERSION=${1#--version=}
        if [ -z "$VERSION" ]; then
          die "Missing value for --version." "Pass a version or dist-tag, for example: --version=latest"
        fi
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        die "Unknown option: $1." "Run with --help to see supported options."
        ;;
    esac
    shift
  done

  if [ "$PURGE" -eq 1 ] && [ "$UNINSTALL" -ne 1 ]; then
    die "--purge can only be used with --uninstall." "Run with --uninstall --purge."
  fi

  if [ -z "${HOME:-}" ]; then
    if [ -z "${BROCO_INSTALL_DIR:-}" ] || [ -z "${BROCO_BIN_DIR:-}" ]; then
      die "HOME is not set." "Set HOME or set both BROCO_INSTALL_DIR and BROCO_BIN_DIR."
    fi
  fi

  INSTALL_DIR=$(resolve_abs_path "${BROCO_INSTALL_DIR:-$HOME/.local/share/broco}")
  BIN_DIR=$(resolve_abs_path "${BROCO_BIN_DIR:-$HOME/.local/bin}")

  if [ "$UNINSTALL" -eq 1 ]; then
    do_uninstall
    exit 0
  fi

  detect_platform
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/broco-install.XXXXXX")

  ensure_node_runtime
  install_broco_package
  write_shim

  installed_ver=$("$SHIM_PATH" --version 2>/dev/null || printf '%s' "$VERSION")
  say "Installed broco ${installed_ver} to ${INSTALL_DIR}"
  say "Shim: ${SHIM_PATH}"

  if ! path_contains "$BIN_DIR"; then
    if [ -n "${HOME:-}" ] && [ "$BIN_DIR" = "$(strip_trailing_slash "$HOME")/.local/bin" ]; then
      display_bin="\$HOME/.local/bin"
    else
      display_bin="$BIN_DIR"
    fi
    say ""
    say "Add broco to your PATH:"
    say "  export PATH=\"${display_bin}:\$PATH\""
  fi

  if [ "$NO_SETUP" -eq 0 ] && is_interactive_tty; then
    say ""
    if ! "$SHIM_PATH" setup < /dev/tty; then
      warn "broco setup exited with an error."
      say "Next: broco setup"
    fi
  else
    say "Next: broco setup"
  fi
}

main "$@"

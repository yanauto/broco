function unsupported() {
  throw new Error('broco desktop integration currently requires macOS, Linux, or Windows')
}

export const platform = process.platform === 'darwin'
  ? await import('./macos.mjs')
  : process.platform === 'linux'
    ? await import('./linux.mjs')
    : process.platform === 'win32'
      ? await import('./windows.mjs')
      : {
          startService: unsupported, removeService: unsupported, removeLegacyService: unsupported, openTerminal: unsupported, pickFolder: unsupported,
          openBrowser: unsupported, hasDesktop: async () => false, openDesktop: unsupported, reveal: unsupported,
          piCommand: unsupported, owned: unsupported, reap: unsupported
        }

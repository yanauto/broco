param(
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$NoSetup,
    [string]$Version = ''
)

& {
    param(
        [bool]$DoUninstall,
        [bool]$DoPurge,
        [bool]$DoNoSetup,
        [string]$RequestedVersion
    )

    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
    }

    $minNodeMajor = 22
    $minNodeMinor = 13
    $minNodePatch = 0
    $minNodeVersion = "$minNodeMajor.$minNodeMinor.$minNodePatch"
    $defaultNodeMirror = 'https://nodejs.org/dist'
    $fallbackNodeMirror = 'https://npmmirror.com/mirrors/node'
    $defaultNpmRegistry = 'https://registry.npmjs.org'
    $fallbackNpmRegistry = 'https://registry.npmmirror.com'
    $packageName = '@yanauto/broco'

    $tmpDir = ''
    $appStage = ''

    function Test-Truthy {
        param([string]$Value)
        if ([string]::IsNullOrWhiteSpace($Value)) {
            return $false
        }
        switch ($Value.Trim().ToLowerInvariant()) {
            '0' { return $false }
            'false' { return $false }
            'no' { return $false }
            default { return $true }
        }
    }

    function Fail {
        param(
            [string]$Message,
            [string]$NextStep = ''
        )
        Write-Host "broco: error: $Message" -ForegroundColor Red
        if ($NextStep) {
            Write-Host "Next: $NextStep"
        }
        throw $Message
    }

    function Warn {
        param([string]$Message)
        Write-Host "broco: $Message" -ForegroundColor Yellow
    }

    function Normalize-PathKey {
        param([string]$PathText)
        if ([string]::IsNullOrWhiteSpace($PathText)) {
            return ''
        }
        $trimmed = $PathText.Trim()
        if ($trimmed.Length -gt 3) {
            $trimmed = $trimmed.TrimEnd('\', '/')
        }
        return $trimmed.ToLowerInvariant()
    }

    function Resolve-CleanPath {
        param([string]$RawPath)
        $full = [System.IO.Path]::GetFullPath($RawPath)
        $root = [System.IO.Path]::GetPathRoot($full)
        if ($full.Length -gt $root.Length) {
            $full = $full.TrimEnd('\', '/')
        }
        return $full
    }

    function Guard-RemovePath {
        param(
            [string]$Target,
            [string]$Label
        )
        if ([string]::IsNullOrWhiteSpace($Target)) {
            Fail "Refusing to remove empty $Label path." 'Set BROCO_INSTALL_DIR to a dedicated directory.'
        }
        $full = Resolve-CleanPath $Target
        $root = [System.IO.Path]::GetPathRoot($full)
        $normFull = Normalize-PathKey $full
        $normRoot = Normalize-PathKey $root
        if ($normFull -eq $normRoot) {
            Fail "Refusing to remove drive root ($full)." 'Set BROCO_INSTALL_DIR to a dedicated subdirectory.'
        }
        $protected = @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:SystemRoot, $env:ProgramFiles)
        foreach ($p in $protected) {
            if ($p -and (Normalize-PathKey (Resolve-CleanPath $p)) -eq $normFull) {
                Fail "Refusing to remove protected $Label directory ($full)." 'Set BROCO_INSTALL_DIR to a dedicated subdirectory.'
            }
        }
    }

    function Move-DirWithRetry {
        param(
            [string]$Source,
            [string]$Destination
        )
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                Move-Item -LiteralPath $Source -Destination $Destination
                return
            } catch {
                if ($attempt -ge 5) {
                    throw
                }
                Start-Sleep -Milliseconds (200 * $attempt)
            }
        }
    }

    function Test-NodeVersion {
        param([string]$VerStr)
        if (-not $VerStr) {
            return $false
        }
        $m = [regex]::Match($VerStr.Trim(), '^v?(\d+)\.(\d+)\.(\d+)')
        if (-not $m.Success) {
            return $false
        }
        $maj = [int]$m.Groups[1].Value
        $min = [int]$m.Groups[2].Value
        $pat = [int]$m.Groups[3].Value
        if ($maj -gt $minNodeMajor) { return $true }
        if ($maj -lt $minNodeMajor) { return $false }
        if ($min -gt $minNodeMinor) { return $true }
        if ($min -lt $minNodeMinor) { return $false }
        return ($pat -ge $minNodePatch)
    }

    function Get-NodeVersion {
        param([string]$NodeExe)
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $out = & $NodeExe -v 2>$null
            if ($LASTEXITCODE -ne 0) {
                return ''
            }
            if ($out -is [array]) {
                return [string]$out[0]
            }
            return [string]$out
        } catch {
            return ''
        } finally {
            $ErrorActionPreference = $prevEap
        }
    }

    function Find-NpmForNode {
        param([string]$NodeExe)
        $nodeDir = Split-Path -Parent $NodeExe
        $cli = Join-Path (Join-Path (Join-Path (Join-Path $nodeDir 'node_modules') 'npm') 'bin') 'npm-cli.js'
        if (Test-Path -LiteralPath $cli -PathType Leaf) {
            return @{ Mode = 'cli'; Path = $cli; NodeDir = $nodeDir }
        }
        $localExe = Join-Path $nodeDir 'npm.exe'
        if (Test-Path -LiteralPath $localExe -PathType Leaf) {
            return @{ Mode = 'cmd'; Path = $localExe; NodeDir = $nodeDir }
        }
        $localCmd = Join-Path $nodeDir 'npm.cmd'
        if (Test-Path -LiteralPath $localCmd -PathType Leaf) {
            return @{ Mode = 'cmd'; Path = $localCmd; NodeDir = $nodeDir }
        }
        $pathCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($null -ne $pathCmd -and $pathCmd.Source -and (Test-Path -LiteralPath $pathCmd.Source -PathType Leaf)) {
            return @{ Mode = 'cmd'; Path = $pathCmd.Source; NodeDir = $nodeDir }
        }
        return $null
    }

    function Get-WinArch {
        $raw = ''
        try {
            $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
            if ($null -ne $osArch) {
                $raw = $osArch.ToString()
            }
        } catch {
        }
        if (-not $raw) {
            if ($env:PROCESSOR_ARCHITEW6432) {
                $raw = $env:PROCESSOR_ARCHITEW6432
            } elseif ($env:PROCESSOR_ARCHITECTURE) {
                $raw = $env:PROCESSOR_ARCHITECTURE
            }
        }
        switch ($raw.ToUpperInvariant()) {
            'X64' { return 'x64' }
            'AMD64' { return 'x64' }
            'ARM64' { return 'arm64' }
            default {
                Fail "Unsupported Windows architecture: $raw (supported: x64, arm64)." "Install Node.js $minNodeVersion+ manually and run: npm install -g $packageName"
            }
        }
    }

    function Try-ReuseNode {
        param(
            [string]$InstallRoot,
            [bool]$ForceDownload
        )
        if ($ForceDownload) {
            return $null
        }
        $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -eq $cmd) {
            $cmd = Get-Command node -ErrorAction SilentlyContinue
        }
        if ($null -ne $cmd -and $cmd.CommandType -eq 'Application' -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
            $ver = Get-NodeVersion $cmd.Source
            if (Test-NodeVersion $ver) {
                $npmInfo = Find-NpmForNode $cmd.Source
                if ($null -ne $npmInfo) {
                    return @{ NodeExe = $cmd.Source; Version = $ver.Trim(); Npm = $npmInfo }
                }
            }
        }
        $existingNode = Join-Path (Join-Path $InstallRoot 'runtime') 'node.exe'
        if (Test-Path -LiteralPath $existingNode -PathType Leaf) {
            $ver = Get-NodeVersion $existingNode
            if (Test-NodeVersion $ver) {
                $npmInfo = Find-NpmForNode $existingNode
                if ($null -ne $npmInfo) {
                    return @{ NodeExe = $existingNode; Version = $ver.Trim(); Npm = $npmInfo }
                }
            }
        }
        return $null
    }

    function Download-NodeFromMirror {
        param(
            [string]$MirrorBase,
            [string]$Arch,
            [string]$InstallRoot,
            [string]$TempRoot
        )
        $base = $MirrorBase.TrimEnd('/')
        $shasumsUrl = "$base/latest-v24.x/SHASUMS256.txt"
        $shasumsFile = Join-Path $TempRoot 'SHASUMS256.txt'
        if (Test-Path -LiteralPath $shasumsFile) {
            Remove-Item -LiteralPath $shasumsFile -Force
        }

        try {
            Invoke-WebRequest -Uri $shasumsUrl -OutFile $shasumsFile -UseBasicParsing -TimeoutSec 30
        } catch {
            return $null
        }

        $pattern = "^\s*([0-9a-fA-F]{64})\s+(node-v24\.\d+\.\d+-win-$Arch\.zip)\s*$"
        $expectedSha = ''
        $archiveName = ''
        foreach ($line in (Get-Content -LiteralPath $shasumsFile)) {
            $m = [regex]::Match($line, $pattern)
            if ($m.Success) {
                $expectedSha = $m.Groups[1].Value.ToLowerInvariant()
                $archiveName = $m.Groups[2].Value
                break
            }
        }
        if (-not $expectedSha -or -not $archiveName) {
            return $null
        }
        if ($archiveName.Contains('/') -or $archiveName.Contains('\') -or $archiveName.Contains('..')) {
            return $null
        }

        $archiveUrl = "$base/latest-v24.x/$archiveName"
        $zipFile = Join-Path $TempRoot $archiveName
        if (Test-Path -LiteralPath $zipFile) {
            Remove-Item -LiteralPath $zipFile -Force
        }

        Write-Host "Downloading $archiveName from $base..."
        try {
            Invoke-WebRequest -Uri $archiveUrl -OutFile $zipFile -UseBasicParsing -TimeoutSec 300
        } catch {
            if (Test-Path -LiteralPath $zipFile) {
                Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
            }
            return $null
        }

        $actualSha = (Get-FileHash -LiteralPath $zipFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSha -ne $expectedSha) {
            Warn "SHA-256 mismatch for $archiveName from $base."
            Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
            return $null
        }

        if (-not (Test-Path -LiteralPath $InstallRoot)) {
            New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        }

        $extractStage = Join-Path $InstallRoot (".extract.$PID")
        try {
            if (Test-Path -LiteralPath $extractStage) {
                Remove-Item -LiteralPath $extractStage -Recurse -Force
            }
            New-Item -ItemType Directory -Path $extractStage -Force | Out-Null

            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($zipFile, $extractStage)

            $extractedName = $archiveName -replace '\.zip$', ''
            $extractedRoot = Join-Path $extractStage $extractedName
            $extractedNode = Join-Path $extractedRoot 'node.exe'
            $extractedNpmCli = Join-Path (Join-Path (Join-Path (Join-Path $extractedRoot 'node_modules') 'npm') 'bin') 'npm-cli.js'
            if (-not (Test-Path -LiteralPath $extractedNode -PathType Leaf) -or -not (Test-Path -LiteralPath $extractedNpmCli -PathType Leaf)) {
                return $null
            }

            $runtimeDir = Join-Path $InstallRoot 'runtime'
            $runtimeOld = Join-Path $InstallRoot (".runtime.old.$PID")
            if (Test-Path -LiteralPath $runtimeOld) {
                Remove-Item -LiteralPath $runtimeOld -Recurse -Force
            }
            if (Test-Path -LiteralPath $runtimeDir) {
                Move-DirWithRetry -Source $runtimeDir -Destination $runtimeOld
                try {
                    Move-DirWithRetry -Source $extractedRoot -Destination $runtimeDir
                } catch {
                    if (-not (Test-Path -LiteralPath $runtimeDir) -and (Test-Path -LiteralPath $runtimeOld)) {
                        Move-Item -LiteralPath $runtimeOld -Destination $runtimeDir -ErrorAction SilentlyContinue
                    }
                    Fail "Failed to update Node.js runtime in $runtimeDir." 'Close running broco processes and rerun.'
                }
                Remove-Item -LiteralPath $runtimeOld -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                Move-DirWithRetry -Source $extractedRoot -Destination $runtimeDir
            }

            $finalNode = Join-Path $runtimeDir 'node.exe'
            $finalVer = (Get-NodeVersion $finalNode).Trim()
            $finalNpm = Find-NpmForNode $finalNode
            return @{ NodeExe = $finalNode; Version = $finalVer; Npm = $finalNpm }
        } finally {
            if (Test-Path -LiteralPath $extractStage) {
                Remove-Item -LiteralPath $extractStage -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    function Run-NpmInstall {
        param(
            [hashtable]$Runtime,
            [string]$TargetDir,
            [string]$CacheDir,
            [string]$PkgSpec,
            [string]$Registry
        )
        if (Test-Path -LiteralPath $TargetDir) {
            Remove-Item -LiteralPath $TargetDir -Recurse -Force
        }
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
        if (-not (Test-Path -LiteralPath $CacheDir)) {
            New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
        }

        $npmArgs = @('install', '--prefix', $TargetDir, '--cache', $CacheDir, '--global=false', '--no-fund', '--no-audit', '--loglevel=error')
        if ($Registry) {
            $npmArgs += @('--registry', $Registry)
        }
        $npmArgs += $PkgSpec

        $clearKeys = @('npm_config_prefix', 'NPM_CONFIG_PREFIX', 'PREFIX', 'npm_config_local_prefix', 'npm_config_global', 'NPM_CONFIG_GLOBAL')
        $savedEnv = @{}
        foreach ($k in $clearKeys) {
            $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
            [Environment]::SetEnvironmentVariable($k, $null, 'Process')
        }
        $savedPath = $env:Path
        $env:Path = "$($Runtime.Npm.NodeDir);$savedPath"
        $prevEap = $ErrorActionPreference

        try {
            $ErrorActionPreference = 'Continue'
            if ($Runtime.Npm.Mode -eq 'cli') {
                & $Runtime.NodeExe $Runtime.Npm.Path @npmArgs
            } else {
                & $Runtime.Npm.Path @npmArgs
            }
            return ($LASTEXITCODE -eq 0)
        } finally {
            $ErrorActionPreference = $prevEap
            $env:Path = $savedPath
            foreach ($k in $clearKeys) {
                [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process')
            }
        }
    }

    function Add-UserPathEntry {
        param([string]$Entry)
        $targetNorm = Normalize-PathKey $Entry
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $foundUser = $false
        if ($userPath) {
            foreach ($p in ($userPath -split ';')) {
                if (-not [string]::IsNullOrWhiteSpace($p) -and (Normalize-PathKey $p) -eq $targetNorm) {
                    $foundUser = $true
                    break
                }
            }
        }
        if (-not $foundUser) {
            if ([string]::IsNullOrEmpty($userPath)) {
                $newUserPath = $Entry
            } elseif ($userPath.EndsWith(';')) {
                $newUserPath = "$userPath$Entry;"
            } else {
                $newUserPath = "$userPath;$Entry"
            }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
        }

        $foundSession = $false
        if ($env:Path) {
            foreach ($p in ($env:Path -split ';')) {
                if (-not [string]::IsNullOrWhiteSpace($p) -and (Normalize-PathKey $p) -eq $targetNorm) {
                    $foundSession = $true
                    break
                }
            }
        }
        if (-not $foundSession) {
            if ([string]::IsNullOrEmpty($env:Path)) {
                $env:Path = $Entry
            } elseif ($env:Path.EndsWith(';')) {
                $env:Path = "$($env:Path)$Entry;"
            } else {
                $env:Path = "$($env:Path);$Entry"
            }
        }
    }

    function Remove-UserPathEntry {
        param([string]$Entry)
        $targetNorm = Normalize-PathKey $Entry
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath) {
            $kept = New-Object System.Collections.Generic.List[string]
            $changed = $false
            foreach ($p in ($userPath -split ';')) {
                if (-not [string]::IsNullOrWhiteSpace($p) -and (Normalize-PathKey $p) -eq $targetNorm) {
                    $changed = $true
                } else {
                    $kept.Add($p)
                }
            }
            if ($changed) {
                $hasNonEmpty = $false
                foreach ($k in $kept) {
                    if (-not [string]::IsNullOrWhiteSpace($k)) {
                        $hasNonEmpty = $true
                        break
                    }
                }
                if (-not $hasNonEmpty) {
                    [Environment]::SetEnvironmentVariable('Path', $null, 'User')
                } else {
                    [Environment]::SetEnvironmentVariable('Path', ($kept.ToArray() -join ';'), 'User')
                }
            }
        }

        if ($env:Path) {
            $sessionKept = New-Object System.Collections.Generic.List[string]
            $sessionChanged = $false
            foreach ($p in ($env:Path -split ';')) {
                if (-not [string]::IsNullOrWhiteSpace($p) -and (Normalize-PathKey $p) -eq $targetNorm) {
                    $sessionChanged = $true
                } else {
                    $sessionKept.Add($p)
                }
            }
            if ($sessionChanged) {
                $env:Path = $sessionKept.ToArray() -join ';'
            }
        }
    }

    function Test-InteractiveConsole {
        if (-not [Environment]::UserInteractive) {
            return $false
        }
        try {
            if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
                return $false
            }
            return $true
        } catch {
            return $false
        }
    }

    try {
        $uninstallMode = $DoUninstall -or (Test-Truthy $env:BROCO_UNINSTALL)
        $purgeMode = $DoPurge -or (Test-Truthy $env:BROCO_PURGE)
        $noSetupMode = $DoNoSetup -or (Test-Truthy $env:BROCO_NO_SETUP)
        $forceRuntime = Test-Truthy $env:BROCO_FORCE_RUNTIME
        $localPackage = $env:BROCO_PACKAGE

        $targetVersion = 'latest'
        if ($env:BROCO_VERSION) {
            $targetVersion = $env:BROCO_VERSION
        }
        if ($RequestedVersion) {
            $targetVersion = $RequestedVersion
        }

        if ($purgeMode -and -not $uninstallMode) {
            Fail '-Purge can only be used with -Uninstall.' 'Run with -Uninstall -Purge (or BROCO_UNINSTALL=1 and BROCO_PURGE=1).'
        }

        $userHome = $env:USERPROFILE
        if (-not $userHome) {
            $userHome = [Environment]::GetFolderPath('UserProfile')
        }
        if (-not $userHome) {
            $userHome = $HOME
        }

        if ($env:BROCO_INSTALL_DIR) {
            $installDir = Resolve-CleanPath $env:BROCO_INSTALL_DIR
        } elseif ($env:LOCALAPPDATA) {
            $installDir = Resolve-CleanPath (Join-Path $env:LOCALAPPDATA 'broco')
        } elseif ($userHome) {
            $installDir = Resolve-CleanPath (Join-Path (Join-Path (Join-Path $userHome 'AppData') 'Local') 'broco')
        } else {
            Fail 'Could not determine install directory.' 'Set BROCO_INSTALL_DIR and rerun.'
        }

        $binDir = Join-Path $installDir 'bin'
        $dataDir = if ($env:BROCO_HOME) { Resolve-CleanPath $env:BROCO_HOME } else { Resolve-CleanPath (Join-Path $userHome '.broco') }

        if ($uninstallMode) {
            Guard-RemovePath $installDir 'install'
            Remove-UserPathEntry $binDir
            if (Test-Path -LiteralPath $installDir) {
                Remove-Item -LiteralPath $installDir -Recurse -Force
            }
            if ($purgeMode) {
                Guard-RemovePath $dataDir 'data'
                if (Test-Path -LiteralPath $dataDir) {
                    Remove-Item -LiteralPath $dataDir -Recurse -Force
                }
                Write-Host "Uninstalled broco and removed data at $dataDir."
            } else {
                Write-Host "Uninstalled broco from $installDir."
                Write-Host "Kept data in $dataDir (pass -Purge to remove it)."
            }
            return
        }

        $arch = Get-WinArch
        $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("broco-install-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

        $runtime = Try-ReuseNode -InstallRoot $installDir -ForceDownload $forceRuntime
        if ($null -ne $runtime) {
            Write-Host "Using Node.js $($runtime.Version) ($($runtime.NodeExe))"
        } else {
            $primaryMirror = if ($env:BROCO_NODE_MIRROR) { $env:BROCO_NODE_MIRROR.TrimEnd('/') } else { $defaultNodeMirror }
            $runtime = Download-NodeFromMirror -MirrorBase $primaryMirror -Arch $arch -InstallRoot $installDir -TempRoot $tmpDir
            if ($null -eq $runtime -and $primaryMirror -ne $fallbackNodeMirror) {
                Warn "Node.js download from $primaryMirror failed; retrying $fallbackNodeMirror..."
                $runtime = Download-NodeFromMirror -MirrorBase $fallbackNodeMirror -Arch $arch -InstallRoot $installDir -TempRoot $tmpDir
            }
            if ($null -eq $runtime) {
                Fail 'Could not download and verify Node.js 24 LTS.' 'Check network access, or set BROCO_NODE_MIRROR and rerun.'
            }
            Write-Host "Installed private Node.js $($runtime.Version) into $(Join-Path $installDir 'runtime')"
        }

        if (-not (Test-Path -LiteralPath $installDir)) {
            New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        }

        $appStage = Join-Path $installDir (".app.new.$PID")
        $npmCache = Join-Path $tmpDir 'npm-cache'

        if ($localPackage) {
            if (-not (Test-Path -LiteralPath $localPackage -PathType Leaf)) {
                Fail "BROCO_PACKAGE file not found: $localPackage." 'Provide a valid .tgz path and rerun.'
            }
            $pkgSpec = [System.IO.Path]::GetFullPath($localPackage)
            Write-Host "Installing broco from $pkgSpec..."
            if (-not (Run-NpmInstall -Runtime $runtime -TargetDir $appStage -CacheDir $npmCache -PkgSpec $pkgSpec -Registry '')) {
                Fail "Failed to install broco from $pkgSpec." 'Verify the tarball is valid and rerun.'
            }
        } else {
            $pkgSpec = "$packageName@$targetVersion"
            $primaryReg = if ($env:BROCO_NPM_REGISTRY) { $env:BROCO_NPM_REGISTRY.TrimEnd('/') } else { $defaultNpmRegistry }
            Write-Host "Installing $pkgSpec..."
            $ok = Run-NpmInstall -Runtime $runtime -TargetDir $appStage -CacheDir $npmCache -PkgSpec $pkgSpec -Registry $primaryReg
            if (-not $ok -and $primaryReg -ne $fallbackNpmRegistry) {
                Warn "npm install from $primaryReg failed; retrying $fallbackNpmRegistry..."
                $ok = Run-NpmInstall -Runtime $runtime -TargetDir $appStage -CacheDir $npmCache -PkgSpec $pkgSpec -Registry $fallbackNpmRegistry
            }
            if (-not $ok) {
                Fail "Failed to install $pkgSpec." 'Check network access, or set BROCO_NPM_REGISTRY and rerun.'
            }
        }

        $stageEntry = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $appStage 'node_modules') '@yanauto') 'broco') 'bin') 'broco'
        if (-not (Test-Path -LiteralPath $stageEntry -PathType Leaf)) {
            Fail 'Installed package is missing bin/broco.' "Verify $packageName version '$targetVersion' and rerun."
        }

        $appDir = Join-Path $installDir 'app'
        $appOld = Join-Path $installDir (".app.old.$PID")
        if (Test-Path -LiteralPath $appOld) {
            Remove-Item -LiteralPath $appOld -Recurse -Force
        }
        if (Test-Path -LiteralPath $appDir) {
            Move-DirWithRetry -Source $appDir -Destination $appOld
            try {
                Move-DirWithRetry -Source $appStage -Destination $appDir
            } catch {
                if (-not (Test-Path -LiteralPath $appDir) -and (Test-Path -LiteralPath $appOld)) {
                    Move-Item -LiteralPath $appOld -Destination $appDir -ErrorAction SilentlyContinue
                }
                Fail "Failed to move broco into $appDir." 'Close running broco processes and rerun.'
            }
            Remove-Item -LiteralPath $appOld -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Move-DirWithRetry -Source $appStage -Destination $appDir
        }
        $appStage = ''

        if (-not (Test-Path -LiteralPath $binDir)) {
            New-Item -ItemType Directory -Path $binDir -Force | Out-Null
        }
        $entryScript = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $appDir 'node_modules') '@yanauto') 'broco') 'bin') 'broco'
        $cmdNode = $runtime.NodeExe.Replace('%', '%%')
        $cmdEntry = $entryScript.Replace('%', '%%')
        $shimPath = Join-Path $binDir 'broco.cmd'
        $shimContent = "@echo off`r`n`"$cmdNode`" `"$cmdEntry`" %*`r`n"
        [System.IO.File]::WriteAllText($shimPath, $shimContent, (New-Object System.Text.UTF8Encoding($false)))

        Add-UserPathEntry $binDir

        $installedVer = $targetVersion
        $prevEap = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $vOut = & $runtime.NodeExe $entryScript --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $vOut) {
                $installedVer = (($vOut | Select-Object -First 1).ToString()).Trim()
            }
        } catch {
        } finally {
            $ErrorActionPreference = $prevEap
        }

        Write-Host "Installed broco $installedVer to $installDir"
        Write-Host "Shim: $shimPath"

        if (-not $noSetupMode -and (Test-InteractiveConsole)) {
            Write-Host ''
            $prevEap = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & $shimPath setup
                if ($LASTEXITCODE -ne 0) {
                    Warn 'broco setup exited with an error.'
                    Write-Host 'Next: broco setup'
                }
            } finally {
                $ErrorActionPreference = $prevEap
            }
        } else {
            Write-Host 'Next: broco setup'
        }
    } finally {
        if ($tmpDir -and (Test-Path -LiteralPath $tmpDir)) {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($appStage -and (Test-Path -LiteralPath $appStage)) {
            Remove-Item -LiteralPath $appStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} $Uninstall.IsPresent $Purge.IsPresent $NoSetup.IsPresent $Version

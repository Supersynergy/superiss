# Install a Superiss release on native Windows (direct mode on Node >= 22.13; the daemon needs WSL2/Linux/macOS).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version 1.6.1] [-From FILE_OR_HTTPS_URL] [-Prefix DIR]
# Default prefix: %LOCALAPPDATA%\superiss. Earlier releases stay installed; `current.txt` names the active one.
param(
  [string]$Version = '1.6.2',
  [string]$From = '',
  [string]$Prefix = (Join-Path $env:LOCALAPPDATA 'superiss')
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "invalid version: $Version" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node >= 22.13 is required and is not installed automatically.' }
$nv = [version]((node --version).TrimStart('v'))
if ($nv -lt [version]'22.13.0') { throw "Node $nv is older than 22.13.0" }
$work = Join-Path ([IO.Path]::GetTempPath()) ('superiss-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $archive = Join-Path $work 'superiss.tar.gz'
  if (-not $From) { $From = "https://github.com/Supersynergy/superiss/releases/download/v$Version/superiss-$Version.tar.gz" }
  if ($From -like 'https://*') {
    Invoke-WebRequest -UseBasicParsing -Uri $From -OutFile $archive
    $expected = ((Invoke-WebRequest -UseBasicParsing -Uri "$From.sha256").Content -split '\s+')[0]
  } elseif ($From -like 'http://*') { throw "refusing plain http: $From" }
  else {
    Copy-Item $From $archive
    if (-not (Test-Path "$From.sha256")) { throw "no $From.sha256 next to the archive" }
    $expected = ((Get-Content "$From.sha256" -Raw) -split '\s+')[0]
  }
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower() -ne $expected.ToLower()) { throw "checksum mismatch for $From" }
  $x = Join-Path $work 'x'; New-Item -ItemType Directory -Path $x | Out-Null
  tar -xzf $archive -C $x
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  $manifests = @(Get-ChildItem -Path $x -Depth 1 -Filter manifest.json -File)
  if ($manifests.Count -ne 1) { throw 'archive must contain exactly one release with manifest.json' }
  $root = $manifests[0].DirectoryName
  $m = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
  if ($m.version -ne $Version) { throw "archive contains $($m.version), expected $Version" }
  if ($m.sourceHash -notmatch '^[0-9a-f]{12,}$') { throw 'invalid sourceHash in manifest' }
  # Probe before anything visible changes.
  $probe = node (Join-Path $root 'packages\superiss\dist\cli.node.js') capabilities --db (Join-Path $work 'probe.db') | ConvertFrom-Json
  if ($probe.version -ne $Version) { throw 'release probe failed' }
  $target = Join-Path $Prefix ("releases\$Version-" + $m.sourceHash.Substring(0, 12))
  New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'releases'), (Join-Path $Prefix 'bin') | Out-Null
  if (Test-Path $target) { Write-Output "already installed: $target" } else { Move-Item $root $target }
  $currentFile = Join-Path $Prefix 'current.txt'
  $previous = if (Test-Path $currentFile) { (Get-Content $currentFile -Raw).Trim() } else { '' }
  Set-Content -NoNewline -Path "$currentFile.tmp" -Value $target
  Move-Item -Force "$currentFile.tmp" $currentFile
  $shim = "@echo off`r`nset /p SIS_ROOT=<`"%~dp0..\current.txt`"`r`nnode `"%SIS_ROOT%\packages\superiss\dist\cli.node.js`" %*`r`n"
  Set-Content -NoNewline -Path (Join-Path $Prefix 'bin\sis.cmd') -Value $shim
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $bin = Join-Path $Prefix 'bin'
  if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User') }
  Write-Output "installed $target (previous: $(if ($previous) { $previous } else { 'none' }))"
  Write-Output (& (Join-Path $bin 'sis.cmd') capabilities --db (Join-Path $work 'probe2.db') | ConvertFrom-Json | Select-Object version, @{n='operations';e={$_.operations.Count}} | ConvertTo-Json -Compress)
  if ($previous) { Write-Output "rollback: Set-Content -NoNewline '$currentFile' '$previous'" }
  Write-Output 'Native Windows runs Superiss in direct mode (no daemon); use WSL2 for sis serve/work as a service.'
} finally { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }

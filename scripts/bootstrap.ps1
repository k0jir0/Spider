param([switch]$RuntimeOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
$portableNode = Join-Path $runtimeRoot 'node\node.exe'
$nodePath = $portableNode

if (Test-Path $nodePath) {
    $version = & $nodePath --version
    if ([version]$version.TrimStart('v') -lt [version]'22.16.0') {
        throw 'The portable Node runtime is too old. Node.js 22.16 or newer is required.'
    }
}

if (-not (Test-Path $nodePath)) {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'Spider requires 64-bit Windows and Node.js 22.16 or newer.'
    }
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -TimeoutSec 60
    $release = $releases | Where-Object { $_.version -like 'v22.*' -and $_.lts } | Select-Object -First 1
    if (-not $release) { throw 'Could not resolve the Node.js 22 LTS release.' }
    $archiveName = "node-$($release.version)-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/$($release.version)"
    $checksums = (Invoke-WebRequest "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60).Content
    $checksumLine = ($checksums -split "`n" | Where-Object { $_.Trim().EndsWith("  $archiveName") })
    if (-not $checksumLine) { throw 'Official Node.js archive checksum is missing.' }
    $expectedHash = ($checksumLine.Trim() -split '\s+')[0]
    $archivePath = Join-Path $runtimeRoot $archiveName
    Write-Host "Downloading official Node.js $($release.version) into .runtime..."
    Invoke-WebRequest "$baseUrl/$archiveName" -OutFile $archivePath -UseBasicParsing -TimeoutSec 600
    if ((Get-FileHash $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'Node.js archive SHA256 verification failed.'
    }
    Expand-Archive -Path $archivePath -DestinationPath $runtimeRoot -Force
    Move-Item (Join-Path $runtimeRoot "node-$($release.version)-win-x64") (Join-Path $runtimeRoot 'node')
    Remove-Item $archivePath
    $nodePath = $portableNode
}

$nodeDirectory = Split-Path -Parent $nodePath
$env:Path = "$nodeDirectory;$env:Path"
Write-Host "Node.js: $(& $nodePath --version)"

if (-not $RuntimeOnly) {
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path $npmCli)) { throw 'The portable npm installation is missing.' }
    Push-Location $projectRoot
    try {
        if (Test-Path 'package-lock.json') { & $nodePath $npmCli ci --no-fund } else { & $nodePath $npmCli install --no-fund }
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        & $nodePath $npmCli run build
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    } finally {
        Pop-Location
    }
}
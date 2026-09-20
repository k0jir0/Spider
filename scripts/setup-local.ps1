param(
    [switch]$InspectOnly,
    [string]$Release = 'b10964',
    [string]$ModelRepository = 'Qwen/Qwen3-1.7B-GGUF',
    [string]$ModelFile = 'Qwen3-1.7B-Q8_0.gguf'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$runtimeRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'
$releasePath = if ($Release -eq 'latest') { 'latest' } else { "tags/$Release" }
$releaseInfo = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/$releasePath" -TimeoutSec 60
$nightlyPointer = $releaseInfo.assets | Where-Object { $_.name -eq 'nightly-tag.txt' } | Select-Object -First 1
if ($nightlyPointer) {
    $pointerContent = (Invoke-WebRequest $nightlyPointer.browser_download_url -UseBasicParsing -TimeoutSec 60).Content
    $nightlyTag = if ($pointerContent -is [byte[]]) {
        [Text.Encoding]::UTF8.GetString($pointerContent).Trim()
    } else {
        $pointerContent.Trim()
    }
    if ($nightlyTag -notmatch '^b[0-9]+$') { throw 'The official nightly build tag was not recognized.' }
    $releaseInfo = Invoke-RestMethod "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$nightlyTag" -TimeoutSec 60
}
$asset = $releaseInfo.assets | Where-Object { $_.name -match '-bin-win-cpu-x64\.zip$' } | Select-Object -First 1
if (-not $asset -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'A checksum-verified official Windows x64 CPU release was not found.'
}
$modelInfo = Invoke-RestMethod "https://huggingface.co/api/models/${ModelRepository}?blobs=true" -TimeoutSec 60
$weights = $modelInfo.siblings | Where-Object { $_.rfilename -eq $ModelFile } | Select-Object -First 1
if (-not $weights -or $weights.lfs.sha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'The official Qwen3 model file or its SHA256 was not found.'
}

Write-Host "llama.cpp: $($releaseInfo.tag_name), $([math]::Round($asset.size / 1MB)) MiB"
Write-Host "${ModelRepository}: $([math]::Round($weights.lfs.size / 1MB)) MiB"
if ($InspectOnly) { return }

function Get-VerifiedDownload {
    param([string]$Url, [string]$Destination, [string]$Sha256)
    if ((Test-Path $Destination) -and (Get-FileHash $Destination -Algorithm SHA256).Hash -eq $Sha256) {
        Write-Host "Verified cached file: $(Split-Path -Leaf $Destination)"
        return
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Write-Host "Downloading $(Split-Path -Leaf $Destination)..."
    $partial = "$Destination.part"
    Invoke-WebRequest $Url -OutFile $partial -UseBasicParsing -TimeoutSec 1800
    if ((Get-FileHash $partial -Algorithm SHA256).Hash -ne $Sha256) {
        throw "SHA256 verification failed for $(Split-Path -Leaf $Destination)."
    }
    Move-Item $partial $Destination -Force
}

$archive = Join-Path $runtimeRoot "downloads\$($asset.name)"
Get-VerifiedDownload -Url $asset.browser_download_url -Destination $archive -Sha256 $asset.digest.Substring(7)
$engineDirectory = Join-Path $runtimeRoot "llama-$($releaseInfo.tag_name)"
Expand-Archive -Path $archive -DestinationPath $engineDirectory -Force
$server = Get-ChildItem $engineDirectory -Filter 'llama-server.exe' -Recurse | Select-Object -First 1
if (-not $server) { throw 'The official archive did not contain llama-server.exe.' }
$modelPath = Join-Path $runtimeRoot "models\$($weights.rfilename)"
$modelUrl = "https://huggingface.co/$ModelRepository/resolve/$($modelInfo.sha)/$($weights.rfilename)"
Get-VerifiedDownload -Url $modelUrl -Destination $modelPath -Sha256 $weights.lfs.sha256

$manifest = [ordered]@{
    release = $releaseInfo.tag_name
    binary = $server.FullName.Substring($runtimeRoot.Length + 1).Replace('\', '/')
    modelFile = $modelPath.Substring($runtimeRoot.Length + 1).Replace('\', '/')
    model = 'spider-local'
    modelRepository = $ModelRepository
    modelRevision = $modelInfo.sha
    modelSha256 = $weights.lfs.sha256
    engineSha256 = $asset.digest.Substring(7)
}
$manifest | ConvertTo-Json | Set-Content (Join-Path $runtimeRoot 'local-model.json') -Encoding UTF8
Write-Host 'Local model setup complete. Downloads were SHA256 verified.'
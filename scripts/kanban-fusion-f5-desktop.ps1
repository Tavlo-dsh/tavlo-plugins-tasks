[CmdletBinding(DefaultParameterSetName = 'Prepare')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Prepare')][string]$PortableZip,
  [Parameter(Mandatory, ParameterSetName = 'Prepare')][string]$Candidate,
  [Parameter(Mandatory, ParameterSetName = 'Prepare')][string]$DshCli,
  [Parameter(Mandatory, ParameterSetName = 'Open')][string]$OpenPrepared
)
$ErrorActionPreference = 'Stop'
$temp = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$keys = @('DSH_HOME','DSH_BIN','DSH_TELEMETRY_DISABLED','npm_config_offline','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$keys += @(Get-ChildItem Env: | Where-Object Name -Match 'API_?KEY|TOKEN|SECRET|PASSWORD|^NODE_(PATH|OPTIONS)$' | ForEach-Object Name)
$previous = @{}
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key) }
try {
  if ($PSCmdlet.ParameterSetName -eq 'Prepare') {
    $zipPath = (Resolve-Path -LiteralPath $PortableZip).Path
    $archive = (Resolve-Path -LiteralPath $Candidate).Path
    $cli = (Resolve-Path -LiteralPath $DshCli).Path
    $root = (New-Item -ItemType Directory (Join-Path $temp ('tavlo-f5-desktop-' + [guid]::NewGuid()))).FullName
  } else {
    $root = (Get-Item -LiteralPath $OpenPrepared).FullName
    if ((Split-Path $root) -ne $temp -or (Split-Path $root -Leaf) -notmatch '^tavlo-f5-desktop-[\da-f-]{36}$') { throw 'Not an F5 temporary profile' }
    $receipt = Get-Content -Raw -LiteralPath (Join-Path $root 'prepared.json') | ConvertFrom-Json
    $cli = $receipt.cli
  }
  $exe = Join-Path $root 'Tavlo.exe'
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $null) }
  $env:DSH_HOME = Join-Path $root 'home'; $env:DSH_BIN = $cli
  $env:DSH_TELEMETRY_DISABLED = '1'; $env:npm_config_offline = 'true'
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $root 'data\webview'
  if ($PSCmdlet.ParameterSetName -eq 'Open') {
    if (Get-Process -Name tavlo,dsh-desktop -ErrorAction SilentlyContinue) { throw 'A desktop instance is running. Quit it yourself, or use a separate test PC.' }
    if (!(Test-Path -LiteralPath (Join-Path $root 'portable')) -or (Get-FileHash $exe).Hash -ne $receipt.exeHash) { throw 'Portable fixture changed' }
    Start-Process -FilePath $exe -WorkingDirectory $root
    return
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entries = @($zip.Entries | Where-Object Name -eq 'Tavlo.exe')
    if ($entries.Count -ne 1 -or !$zip.GetEntry(($entries[0].FullName -replace 'Tavlo\.exe$', 'portable'))) { throw 'Expected a Tavlo portable archive' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $exe)
  } finally { $zip.Dispose() }
  [IO.File]::WriteAllText((Join-Path $root 'portable'), '')
  Push-Location $root
  try {
    & node $cli plugin --profile web add --prod $archive --offline --reporter=append-only
    if ($LASTEXITCODE) { throw 'Offline candidate installation failed' }
  } finally { Pop-Location }
  $docs = (New-Item -ItemType Directory (Join-Path $root 'documents')).FullName | ConvertTo-Json -Compress
  $seed = Join-Path $root 'seed.mjs'
  [IO.File]::WriteAllText($seed, @'
export const inject = ['taskService']
export async function apply(ctx) {
  for (let index = 1; index <= 12; index++) {
    const result = await ctx.taskService.execute('create', { title: `F5 touch ${index}`, requestId: `f5-touch-${index}` })
    if (!result.ok) throw Error(result.error.code)
  }
}
'@)
  $seedUrl = ([uri]$seed).AbsoluteUri | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $env:DSH_HOME 'profiles/web/cordis.patch.yml'), @"
- id: agent-default-model
  config: {provider: tasks-f5-offline, model: offline}
- id: workspace-controller
  config:
    documentsDirectory: $docs
- id: ui-settings-account
  disabled: true
- id: ui-settings-models
  disabled: true
- insert:
    - id: f5-manual-fixture
      name: $seedUrl
"@)
  $receipt = @{ cli = $cli; candidate = (Get-FileHash $archive).Hash; portableZip = (Get-FileHash $zipPath).Hash; exeHash = (Get-FileHash $exe).Hash }
  [IO.File]::WriteAllText((Join-Path $root 'prepared.json'), ($receipt | ConvertTo-Json))
  Write-Output "Prepared (not started): $root"
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key]) }
}

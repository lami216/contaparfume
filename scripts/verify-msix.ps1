param(
  [Parameter(Mandatory=$true)][string]$PackagePath,
  [Parameter(Mandatory=$true)][string]$IdentityName,
  [Parameter(Mandatory=$true)][string]$Publisher
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageFile = Get-Item -LiteralPath $PackagePath
if ($packageFile.Extension -ne '.msix' -or $packageFile.Length -lt 1MB) { throw 'Missing or truncated MSIX package' }
$zip = [System.IO.Compression.ZipFile]::OpenRead($packageFile.FullName)
try {
  $entries = @{}
  foreach ($entry in $zip.Entries) { $entries[$entry.FullName.Replace('\','/')] = $entry }
  foreach ($required in @('AppxManifest.xml','AppxBlockMap.xml','[Content_Types].xml','app/AlKarnaPerfume.exe','app/resources/app.asar','app/resources/alkarna-runtime/server.js','app/resources/alkarna-runtime/node_modules/better-sqlite3/prebuilds/win32-x64.node','app/resources/alkarna-runtime/node_modules/sql.js/dist/sql-wasm.wasm','assets/StoreLogo.png','assets/Square150x150Logo.png','assets/Square44x44Logo.png')) {
    if (-not $entries.ContainsKey($required) -or $entries[$required].Length -eq 0) { throw "MSIX missing: $required" }
  }
  $reader = [System.IO.StreamReader]::new($entries['AppxManifest.xml'].Open())
  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($manifest.Package.Identity.Name -cne $IdentityName) { throw 'MSIX identity differs from requested identity' }
  if ($manifest.Package.Identity.Publisher -cne $Publisher) { throw 'MSIX publisher differs from requested publisher' }
  if ($manifest.Package.Identity.ProcessorArchitecture -ne 'x64') { throw 'MSIX must be x64' }
  $sourceVersion = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
  if ($manifest.Package.Identity.Version -ne "$sourceVersion.0") { throw 'MSIX version must match source with revision 0' }
  if ($manifest.Package.Applications.Application.EntryPoint -ne 'Windows.FullTrustApplication') { throw 'MSIX full-trust entry point missing' }
  if ($manifest.Package.Applications.Application.Executable.Replace('\','/') -ne 'app/AlKarnaPerfume.exe') { throw 'MSIX executable mismatch' }
  $capabilities = @($manifest.Package.Capabilities.ChildNodes | Where-Object NodeType -eq Element | ForEach-Object { $_.GetAttribute('Name') })
  if ($capabilities.Count -ne 1 -or $capabilities[0] -ne 'runFullTrust') { throw 'Unexpected MSIX capabilities' }
  $languages = @($manifest.Package.Resources.Resource | ForEach-Object { $_.Language })
  if ('ar' -notin $languages -or 'fr' -notin $languages) { throw 'MSIX Arabic/French languages missing' }
  Write-Host "MSIX structure, identity, runtime and version verified: $($packageFile.Name)"
} finally { $zip.Dispose() }

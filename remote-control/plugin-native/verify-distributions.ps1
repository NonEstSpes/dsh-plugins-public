$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base = $PSScriptRoot
$inventory = Get-Content -LiteralPath "$base\dist\input-inventory.json" -Raw | ConvertFrom-Json
$refresh = Get-Content -LiteralPath "$base\client-refresh-report.json" -Raw | ConvertFrom-Json
function Read-ZipJson($archive, $name) {
  $entry = $archive.GetEntry($name)
  if ($null -eq $entry) { throw "Missing archive entry: $name" }
  $reader = New-Object System.IO.StreamReader($entry.Open())
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}
function Get-ZipEntryHash($archive, $name) {
  $entry = $archive.GetEntry($name)
  if ($null -eq $entry) { throw "Missing archive entry: $name" }
  $stream = $entry.Open()
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
$results = @()
foreach ($role in @('controller', 'worker')) {
  $file = Join-Path $base "dist\$role-extension-0.1.0.zip"
  $prefix = if ($role -eq 'controller') { 'bundle/' } else { 'worker-bundle/' }
  $archive = [System.IO.Compression.ZipFile]::OpenRead($file)
  try {
    $entries = @($archive.Entries | Where-Object { $_.Name -ne '' })
    if ($entries.Count -ne $inventory.$role.files) { throw "Archive file count mismatch: $role" }
    foreach ($entry in $entries) {
      if (-not $entry.FullName.StartsWith($prefix) -or $entry.FullName.Contains('\') -or $entry.FullName.Split('/') -contains '..') { throw "Nonportable archive path: $($entry.FullName)" }
    }
    $manifest = Read-ZipJson $archive ($prefix + 'package.json')
    foreach ($dependency in $manifest.dependencies.PSObject.Properties) {
      if (-not $dependency.Value.StartsWith('file:./')) { throw "Noninternal file dependency: $($dependency.Name)" }
      $child = Read-ZipJson $archive ($prefix + $dependency.Value.Substring(7) + '/package.json')
      if ($child.name -ne $dependency.Name) { throw "Dependency identity mismatch: $($dependency.Name)" }
    }
    foreach ($change in $refresh.changes) {
      if ($role -eq 'worker' -and -not $change.file.StartsWith('packages/worker-session-controller/')) { continue }
      if ((Get-ZipEntryHash $archive ($prefix + $change.file)) -ne $change.after) { throw "Stale Client in archive: $role/$($change.file)" }
    }
    $results += [ordered]@{ role = $role; file = $file; name = $manifest.name; version = $manifest.version; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $file).Length; files = $entries.Count; root = $prefix; internalDependenciesVerified = $true; latestAckClientsVerified = $true }
  } finally { $archive.Dispose() }
}
[ordered]@{ builtAt = (Get-Date).ToUniversalTime().ToString('o'); archives = $results; noRuntimeCopies = $true; workerConfigRequiresExplicitPreservation = $true } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$base\dist\distribution-report.json" -Encoding UTF8
$results | ForEach-Object { Write-Output ("READY {0} {1} bytes SHA256 {2}" -f $_.role, $_.bytes, $_.sha256) }

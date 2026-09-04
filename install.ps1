param(
  [Parameter(Mandatory=$true)][string]$Target,
  [switch]$ReplaceConfig,
  [switch]$DryRun
)
$argsList = @($Target)
if ($ReplaceConfig) { $argsList += "--replace-config" }
if ($DryRun) { $argsList += "--dry-run" }
python "$PSScriptRoot\install.py" @argsList

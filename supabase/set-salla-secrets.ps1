# Saves the three Salla keys into Supabase Edge Function secrets.
# Values are typed hidden, written to a temp file, sent with the Supabase CLI, then the file is deleted.
# Nothing is printed or stored in this project.
$ErrorActionPreference = 'Stop'
$project = 'gjjkdzxmpvjzahujddxo'

function Read-Hidden([string]$label) {
  while ($true) {
    $s = Read-Host -AsSecureString "Paste $label then press Enter"
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    $v = $v.Trim()
    if ($v.Length -ge 8) { return $v }
    Write-Host "  Empty or too short - try again." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Copy each value from your app page in Salla Partners (Bella Rosita Inventory)." -ForegroundColor Cyan
Write-Host "Right-click pastes in this window. The value stays hidden." -ForegroundColor Cyan
Write-Host ""
$id      = Read-Hidden 'Client ID'
$secret  = Read-Hidden 'Client Secret'
$webhook = Read-Hidden 'Webhook Secret'

$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "salla-$([guid]::NewGuid()).env")
try {
  [IO.File]::WriteAllLines($tmp, @("SALLA_CLIENT_ID=$id", "SALLA_CLIENT_SECRET=$secret", "SALLA_WEBHOOK_SECRET=$webhook"))
  npx -y supabase secrets set --env-file $tmp --remote=$project --yes
  if ($LASTEXITCODE -ne 0) { throw "Supabase CLI failed (exit $LASTEXITCODE)" }
  Write-Host ""
  Write-Host "Done: SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, SALLA_WEBHOOK_SECRET saved." -ForegroundColor Green
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  $id = $null; $secret = $null; $webhook = $null
}

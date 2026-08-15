# scripts/test-order-ingest.ps1
# Prueba el webhook POST /api/webhooks/orders firmando el body con HMAC-SHA256.
#
# Uso:
#   .\scripts\test-order-ingest.ps1
#   .\scripts\test-order-ingest.ps1 -Secret "tu_secreto"
#   $env:ORDER_INGEST_SECRET = "..."; .\scripts\test-order-ingest.ps1
#
# El secreto debe ser el mismo que:
#   npx wrangler secret put ORDER_INGEST_SECRET

param(
  [string]$Secret = "",
  [string]$TenantId = "empresa_base",
  [string]$BaseUrl = "https://lead-rescue-pipeline.marceloetcheverry990.workers.dev",
  [string]$OtId = ""
)

$ErrorActionPreference = "Stop"

function Get-SecretFromDevVars {
  $candidates = @(
    (Join-Path $PSScriptRoot "..\src\.dev.vars"),
    (Join-Path $PSScriptRoot "..\.dev.vars")
  )
  foreach ($path in $candidates) {
    $full = [IO.Path]::GetFullPath($path)
    if (-not (Test-Path $full)) { continue }
    foreach ($line in Get-Content $full) {
      if ($line -match '^\s*ORDER_INGEST_SECRET\s*=\s*(.+)\s*$') {
        $val = $Matches[1].Trim().Trim('"').Trim("'")
        if ($val) { return $val }
      }
    }
  }
  return $null
}

if (-not $Secret) { $Secret = $env:ORDER_INGEST_SECRET }
if (-not $Secret) { $Secret = Get-SecretFromDevVars }

if (-not $Secret) {
  Write-Host @"
Falta ORDER_INGEST_SECRET.

1) Generá y cargá el secreto en Cloudflare:
   cd lead-rescue-worker
   npx wrangler secret put ORDER_INGEST_SECRET

2) Guardá el MISMO valor en src\.dev.vars (gitignored):
   ORDER_INGEST_SECRET=tu_secreto_aqui

3) Volvé a correr:
   .\scripts\test-order-ingest.ps1
"@ -ForegroundColor Yellow
  exit 1
}

if (-not $OtId) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OtId = "TEST-HMAC-$stamp"
}

# Body compacto: debe firmarse EXACTAMENTE el mismo string que se envía.
$payload = [ordered]@{
  tenant_id       = $TenantId
  source          = "test-powershell"
  idempotency_key = "ps1-$OtId"
  orders          = @(
    [ordered]@{
      ot_id          = $OtId
      cliente        = "Casa Penaflor Test"
      direccion      = "Pasaje Cordillera de Dona Ana 2610, Penaflor"
      lat            = -33.6103
      lng            = -70.8874
      valor_oc_clp   = 15000
      fecha_hora_sla = (Get-Date).ToUniversalTime().AddHours(8).ToString("yyyy-MM-ddTHH:mm:ss.000Z")
      external_ref   = "ps1-smoke"
    }
  )
}

$body = ($payload | ConvertTo-Json -Depth 8 -Compress)

$hmac = [System.Security.Cryptography.HMACSHA256]::new(
  [Text.Encoding]::UTF8.GetBytes($Secret)
)
try {
  $hashBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))
} finally {
  $hmac.Dispose()
}
$sigHex = ([BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
$signature = "sha256=$sigHex"

$uri = "$BaseUrl/api/webhooks/orders"
Write-Host "POST $uri" -ForegroundColor Cyan
Write-Host "ot_id=$OtId  tenant=$TenantId" -ForegroundColor Cyan

try {
  $response = Invoke-WebRequest -Method POST -Uri $uri -Headers @{
    "Content-Type"        = "application/json"
    "X-Tenant-Id"         = $TenantId
    "X-Hub-Signature-256" = $signature
  } -Body $body -UseBasicParsing

  Write-Host "HTTP $($response.StatusCode)" -ForegroundColor Green
  Write-Host $response.Content
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    Write-Host "HTTP $([int]$resp.StatusCode)" -ForegroundColor Red
    Write-Host $text
    if ([int]$resp.StatusCode -eq 503) {
      Write-Host "`nHint: el Worker no tiene ORDER_INGEST_SECRET. Corré wrangler secret put." -ForegroundColor Yellow
    }
    if ([int]$resp.StatusCode -eq 401) {
      Write-Host "`nHint: el secreto local no coincide con el de Cloudflare." -ForegroundColor Yellow
    }
  } else {
    throw
  }
  exit 1
}

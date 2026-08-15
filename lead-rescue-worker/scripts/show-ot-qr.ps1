# Abre un QR en el navegador con el ot_id (para imprimir / probar el escáner).
# Uso:
#   .\scripts\show-ot-qr.ps1 -OtId "TEST-HMAC-20260722-022522"

param(
  [Parameter(Mandatory = $true)]
  [string]$OtId
)

$encoded = [uri]::EscapeDataString($OtId)
$url = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=$encoded"
Write-Host "OT: $OtId"
Write-Host "QR: $url"
Start-Process $url

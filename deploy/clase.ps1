<#
  Sube o baja el plan de UN Code Sala para pagar solo las horas de clase.

    .\deploy\clase.ps1 -Modo subir   # antes de la clase: plan B1 (se factura por hora)
    .\deploy\clase.ps1 -Modo bajar   # al terminar: plan F1 gratuito (no se factura)

  El plan de App Service se factura por hora, prorrateado al segundo, según su nivel. En F1 no hay
  cobro, pero solo admite 3 conexiones simultáneas (medido) y una cuota de CPU diaria: sirve para dejar la app
  aparcada, no para una clase. Las salas se guardan en /home/data y sobreviven al cambio de nivel.
#>
param(
  [Parameter(Mandatory)][ValidateSet('subir', 'bajar')][string]$Modo,
  [string]$ResourceGroup = 'codesala-rg',
  # Cuánto esperar a que la app vuelva a responder tras el cambio (Azure hace un relevo de contenedor)
  [int]$EsperaSegundos = 240
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "Falló: az $($args -join ' ')" }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Falta la CLI de Azure o no hay sesión: ejecuta "az login".' }

# Debe haber exactamente un plan y una app en el grupo.
$plans = @((& az appservice plan list -g $ResourceGroup --query '[].name' -o tsv) | Where-Object { $_ })
$apps = @((& az webapp list -g $ResourceGroup --query '[].name' -o tsv) | Where-Object { $_ })
if ($plans.Count -ne 1 -or $apps.Count -ne 1) {
  throw "Se esperaba 1 plan y 1 app en '$ResourceGroup' y hay $($plans.Count) plan(es) y $($apps.Count) app(s). Revisa el portal."
}
$plan = $plans[0]
$app = $apps[0]

if ($Modo -eq 'subir') {
  Invoke-Az appservice plan update -g $ResourceGroup -n $plan --sku B1 -o none
  Invoke-Az webapp config set -g $ResourceGroup -n $app --web-sockets-enabled true --always-on true -o none
} else {
  # F1 no admite "Always On": se apaga antes de bajar de nivel.
  Invoke-Az webapp config set -g $ResourceGroup -n $app --always-on false -o none
  Invoke-Az appservice plan update -g $ResourceGroup -n $plan --sku F1 -o none
}

$now = (& az appservice plan show -g $ResourceGroup -n $plan -o json) | ConvertFrom-Json
Write-Host "Plan '$plan': nivel $($now.sku.name), instancias $($now.sku.capacity)"
if ($Modo -eq 'subir' -and $now.sku.name -ne 'B1') { Write-Warning 'El plan no quedó en B1. Revisa el portal.' }
if ($Modo -eq 'bajar') {
  if ($now.sku.name -eq 'F1') { Write-Host 'Listo: en F1 no se factura el plan.' }
  else { Write-Warning "El plan sigue en $($now.sku.name) y se está facturando. Revisa el portal." }
}

# Tras el cambio Azure sustituye el contenedor y, durante uno o dos minutos, puede responder 503.
# Se espera a que la app vuelva a servir antes de dar el cambio por terminado.
$url = 'https://' + (& az webapp show -g $ResourceGroup -n $app --query defaultHostName -o tsv)
Write-Host "Esperando a que $url vuelva a responder ..."
$ok = $false
$deadline = (Get-Date).AddSeconds($EsperaSegundos)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-RestMethod "$url/version" -TimeoutSec 30
    if ($r.version) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 10
}
if ($ok) { Write-Host "La app responde: $url" -ForegroundColor Green }
else { Write-Warning "La app aún no responde. Suele ser el relevo del contenedor; vuelve a probar en un minuto." }

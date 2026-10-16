<#
  Despliega UN Code Sala en Azure App Service (Linux, plan B1, UNA sola instancia) y verifica que no
  se haya creado nada que genere costos extra. Pensado para suscripciones "Azure for Students".

  Uso, en PowerShell y desde la carpeta codesala:
      az login
      .\deploy\azure.ps1 -AppName uncodesala-tunombre -Location <region permitida>

  Lee deploy\AZURE.md antes de ejecutarlo (regiones permitidas, presupuesto y cómo borrarlo todo).
#>
param(
  # Nombre único en todo Azure: la dirección será https://<AppName>.azurewebsites.net
  [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$')][string]$AppName,
  # Región PERMITIDA por la política de tu suscripción (ver deploy\AZURE.md)
  [Parameter(Mandatory)][string]$Location,
  [string]$ResourceGroup = 'codesala-rg',
  [string]$Runtime = 'NODE:22-lts',
  # Un plan B1 admite hasta 350 WebSockets por instancia (dato de Microsoft Q&A, verifícalo)
  [int]$MaxConnsPerRoom = 300
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$planName = "$AppName-plan"

# Ejecuta az y falla si devuelve error (PowerShell no lo hace solo con programas externos).
function Invoke-Az {
  & az @args
  if ($LASTEXITCODE -ne 0) { throw "Falló: az $($args -join ' ')" }
}

# 0. Comprobaciones previas -------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Falta la CLI de Azure. Instálala desde https://learn.microsoft.com/cli/azure/install-azure-cli y ejecuta "az login".'
}
$account = (& az account show -o json 2>$null) | ConvertFrom-Json
if (-not $account) { throw 'No hay sesión iniciada. Ejecuta "az login" primero.' }
Write-Host "Suscripción: $($account.name) ($($account.id))"
if ($account.name -notmatch 'Student') {
  Write-Warning 'Esta suscripción no parece "Azure for Students". Si es de pago por uso, el plan B1 SÍ genera cobros (unos 13 USD al mes).'
  if ((Read-Host 'Escribe SI para continuar') -ne 'SI') { throw 'Cancelado.' }
}

# 1. Recursos: solo un plan B1 y una app web --------------------------------------------
try {
  Invoke-Az group create -n $ResourceGroup -l $Location -o none
  Invoke-Az appservice plan create -g $ResourceGroup -n $planName --is-linux --sku B1 --number-of-workers 1 -o none
} catch {
  Write-Host "`nSi el error menciona 'RequestDisallowedByAzure', la región '$Location' no está permitida en tu suscripción." -ForegroundColor Yellow
  Write-Host 'Mira las regiones permitidas (deploy\AZURE.md, paso 2) y vuelve a ejecutar con otra.' -ForegroundColor Yellow
  # Un grupo de recursos queda atado a su región: si quedó vacío, se borra para poder reintentar en otra.
  $left = (& az resource list -g $ResourceGroup --query 'length(@)' -o tsv 2>$null)
  if ($left -eq '0') {
    & az group delete -n $ResourceGroup --yes --no-wait 2>$null
    Write-Host "Se borró el grupo '$ResourceGroup' vacío; espera un minuto antes de reintentar." -ForegroundColor Yellow
  }
  throw
}
Invoke-Az webapp create -g $ResourceGroup -p $planName -n $AppName --runtime $Runtime -o none

# 2. Configuración: WebSockets, siempre encendida, solo HTTPS, sin afinidad de sesión ---
Invoke-Az webapp config set -g $ResourceGroup -n $AppName --web-sockets-enabled true --always-on true --min-tls-version 1.2 --startup-file 'node server/index.js' -o none
Invoke-Az webapp update -g $ResourceGroup -n $AppName --https-only true --client-affinity-enabled false -o none
Invoke-Az webapp config appsettings set -g $ResourceGroup -n $AppName -o none --settings `
  DATA_DIR=/home/data TRUST_PROXY=1 "MAX_CONNS_PER_ROOM=$MaxConnsPerRoom" SCM_DO_BUILD_DURING_DEPLOYMENT=false

# 3. Subida: se compila aquí y a Azure solo se sube lo necesario para ejecutar. Compilar en el
#    servidor (plan B1, poca memoria) tumbaba el servicio de despliegue con un error 502.
& "$PSScriptRoot\publicar.ps1" -ResourceGroup $ResourceGroup -AppName $AppName

# 4. Verificación de costos --------------------------------------------------------------
$plan = (& az appservice plan show -g $ResourceGroup -n $planName -o json) | ConvertFrom-Json
$resources = (& az resource list -g $ResourceGroup --query '[].{tipo:type, nombre:name}' -o json) | ConvertFrom-Json
Write-Host "`nPlan: $($plan.sku.name), instancias: $($plan.sku.capacity)"
$resources | ForEach-Object { Write-Host "  - $($_.tipo)  $($_.nombre)" }
if ($plan.sku.name -ne 'B1' -or $plan.sku.capacity -ne 1) { Write-Warning 'El plan NO es B1 con una instancia: revísalo en el portal.' }
$extras = $resources | Where-Object { $_.tipo -notin 'Microsoft.Web/serverFarms', 'Microsoft.Web/sites' }
if ($extras) { Write-Warning 'Hay recursos adicionales que podrían tener costo. Revísalos en el portal.' }

# Azure añade un sufijo aleatorio al nombre de host, así que se consulta la dirección real.
$url = "https://$(& az webapp show -g $ResourceGroup -n $AppName --query defaultHostName -o tsv)"
Write-Host "`nListo: $url"
Write-Host 'Comprueba que responde y haz la prueba de carga antes de la clase:'
Write-Host "  npm run loadtest -- --url $url --viewers 200"
Write-Host "Para borrar TODO y detener el consumo:  az group delete -n $ResourceGroup --yes"

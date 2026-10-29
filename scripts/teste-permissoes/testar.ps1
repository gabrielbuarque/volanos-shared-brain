# Teste de permissões ponta a ponta contra o Worker publicado.
#   .\testar.ps1 -Etapa classificar   (dry run: mostra o nível que o Jev daria a cada trecho, não grava nada)
#   .\testar.ps1 -Etapa ingerir       (grava o documento como dono, gera embeddings e cria o membro de teste P4)
#   .\testar.ps1 -Etapa verificar     (faz as perguntas com o token do dono e com o token P4 e compara)
#   .\testar.ps1 -Etapa limpar        (suspende o membro de teste)
# O token do dono vem de app\.dev.vars e nunca é impresso.
param(
  [Parameter(Mandatory = $true)][ValidateSet("classificar", "ingerir", "verificar", "limpar")][string]$Etapa,
  [string]$Base = "https://second-brain.gabriel-fde.workers.dev",
  [int]$NivelTeste = 4
)
$ErrorActionPreference = "Stop"
$aqui = $PSScriptRoot
$estado = Join-Path $aqui ".estado-teste.json"

$linha = Get-Content (Join-Path $aqui "..\..\.dev.vars") | Where-Object { $_ -match "^AUTH_TOKEN=" } | Select-Object -First 1
if (-not $linha) { throw "AUTH_TOKEN não encontrado em .dev.vars" }
$tokenDono = ($linha -replace "^AUTH_TOKEN=", "").Trim().Trim('"').Trim("'")

function Chamar($metodo, $caminho, $token, $corpo) {
  $h = @{ Authorization = "Bearer $token" }
  $args2 = @{ Method = $metodo; Uri = "$Base$caminho"; Headers = $h; ContentType = "application/json; charset=utf-8" }
  if ($null -ne $corpo) { $args2.Body = [System.Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Depth 8)) }
  Invoke-RestMethod @args2
}

$doc = Get-Content (Join-Path $aqui "documento-teste.md") -Raw -Encoding UTF8
$arquivo = @{ path = "teste-permissoes/relatorio-atlas-ficticia.md"; content = $doc; source = "teste-permissoes" }

# Pergunta -> nível mínimo do código esperado. Cada pergunta mira uma seção.
$perguntas = @(
  @{ q = "valuation em negociação venda de 30% da empresa fundo Horizonte Azul"; cod = "ZEBRA"; nivel = 0 }
  @{ q = "sair do varejo em 2027 estratégia não anunciada"; cod = "LEAO"; nivel = 1 }
  @{ q = "reajuste salarial da designer Marina Teixeira e avaliação"; cod = "PANDA"; nivel = 2 }
  @{ q = "receita do terceiro trimestre margem líquida e caixa"; cod = "TIGRE"; nivel = 3 }
  @{ q = "o diretor da Mercado Lume vai vender a unidade de Recife limite de desconto"; cod = "LOBO"; nivel = 4 }
  @{ q = "taxa de abertura da campanha de outubro sob NDA"; cod = "URSO"; nivel = 5 }
  @{ q = "pipeline do mês e tabela de preços do Forge"; cod = "ONCA"; nivel = 6 }
  @{ q = "como pedir uma ferramenta nova"; cod = "COALA"; nivel = 7 }
  @{ q = "política de uso de IA dados de cliente"; cod = "GARCA"; nivel = 8 }
  @{ q = "brief do freelancer projeto de motion vídeos"; cod = "LINCE"; nivel = 9 }
  @{ q = "paleta aprovada pelo cliente texto da chamada"; cod = "ARARA"; nivel = 10 }
  @{ q = "como funciona o método Genesis etapas"; cod = "TUCANO"; nivel = 11 }
  @{ q = "posicionamento público da Atlas Fictícia"; cod = "GAIVOTA"; nivel = 12 }
)

function Codigos($objeto) {
  $texto = $objeto | ConvertTo-Json -Depth 20 -Compress
  [regex]::Matches($texto, "CODIGO-([A-Z]+)-P(\d+)") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
}

switch ($Etapa) {
  "classificar" {
    $r = Chamar "POST" "/bulk-ingest" $tokenDono @{ files = @($arquivo); dry_run = $true; workspace = "company" }
    "Resumo: publicados=$($r.published) quarentena=$($r.quarantined) revisao=$($r.flagged_for_review)"
    $r.chunks | ForEach-Object {
      $esp = if ($_.section -match "Negociação") { 0 } elseif ($_.section -match "Estratégia") { 1 } elseif ($_.section -match "Reajuste") { 2 } elseif ($_.section -match "Receita") { 3 } elseif ($_.section -match "Segredo") { 4 } elseif ($_.section -match "NDA") { 5 } elseif ($_.section -match "Pipeline") { 6 } elseif ($_.section -match "ferramenta") { 7 } elseif ($_.section -match "Política") { 8 } elseif ($_.section -match "Brief") { 9 } elseif ($_.section -match "Paleta") { 10 } elseif ($_.section -match "Genesis") { 11 } elseif ($_.section -match "Posicionamento") { 12 } else { $null }
      [pscustomobject]@{ Secao = $_.section; Esperado = $esp; Jev = $_.level; Resultado = $_.outcome; Motivo = $_.reason; Conf = $_.confidence }
    } | Format-Table -AutoSize
  }
  "ingerir" {
    $r = Chamar "POST" "/bulk-ingest" $tokenDono @{ files = @($arquivo); workspace = "company" }
    "Ingest: publicados=$($r.published) quarentena=$($r.quarantined) revisao=$($r.flagged_for_review) ja_existiam=$($r.already_present)"
    $r.by_level | ConvertTo-Json -Compress
    for ($i = 0; $i -lt 10; $i++) {
      $v = Chamar "POST" "/vectorize-pending" $tokenDono @{}
      "vectorize restante: $($v.remaining)"
      if (-not $v.remaining) { break }
    }
    if (-not (Test-Path $estado)) {
      $nome = "teste-p$NivelTeste-" + (Get-Date -Format "yyyyMMddHHmm")
      $m = Chamar "POST" "/team/members" $tokenDono @{ name = $nome; role = "member" }
      Chamar "POST" "/permissions/members/clearance" $tokenDono @{ id = $m.member.userId; clearance_floor = $NivelTeste } | Out-Null
      @{ id = $m.member.userId; token = $m.token; nivel = $NivelTeste } | ConvertTo-Json | Set-Content $estado -Encoding UTF8
      "Membro de teste criado (P$NivelTeste): $nome"
    } else { "Membro de teste já existe (.estado-teste.json)" }
    "Se houve quarentena, aprove em Equipe -> contribuições antes de verificar."
  }
  "verificar" {
    if (-not (Test-Path $estado)) { throw "Rode a etapa ingerir primeiro." }
    $e = Get-Content $estado -Raw | ConvertFrom-Json
    $falhas = 0
    $linhas = foreach ($p in $perguntas) {
      $caminho = "/recall?full=1&query=" + [uri]::EscapeDataString($p.q)
      $dono = @(Codigos (Chamar "GET" $caminho $tokenDono $null))
      $teste = @(Codigos (Chamar "GET" $caminho $e.token $null))
      $deveVer = $p.nivel -ge $e.nivel
      $viuTeste = $teste -contains $p.cod
      $viuDono = $dono -contains $p.cod
      $vazou = $false
      foreach ($c in $teste) { $q2 = $perguntas | Where-Object { $_.cod -eq $c }; if ($q2 -and $q2.nivel -lt $e.nivel) { $vazou = $true } }
      $ok = ($viuTeste -eq $deveVer) -and (-not $vazou)
      if (-not $ok) { $falhas++ }
      [pscustomobject]@{ Secao = "P$($p.nivel) $($p.cod)"; DonoVe = $viuDono; P4DeveVer = $deveVer; P4Viu = $viuTeste; Vazou = $vazou; OK = $ok }
    }
    $linhas | Format-Table -AutoSize
    if ($falhas -eq 0) { "RESULTADO: tudo certo. O membro P$($e.nivel) só viu P$($e.nivel) para baixo (mais aberto)." } else { "RESULTADO: $falhas pergunta(s) com problema. Veja a coluna OK/Vazou." }
  }
  "limpar" {
    if (-not (Test-Path $estado)) { "Nada a limpar."; return }
    $e = Get-Content $estado -Raw | ConvertFrom-Json
    Chamar "POST" "/team/members/suspend" $tokenDono @{ id = $e.id; suspended = $true } | Out-Null
    Remove-Item $estado
    "Membro de teste suspenso."
  }
}

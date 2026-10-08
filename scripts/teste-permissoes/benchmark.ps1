# Bateria completa contra o Worker publicado, com documentos reais (sem nenhuma marca de nível no texto).
#   .\benchmark.ps1 -Etapa ingerir   classifica (dry run), mede a acurácia contra gabarito.json, grava e vetoriza
#   .\benchmark.ps1 -Etapa medir     recall e chat, reranker off x jev, dono x membro de teste
# O gabarito fica em gabarito.json e nunca é enviado ao Brain. O token do dono vem de .dev.vars e nunca é impresso.
param(
  [Parameter(Mandatory = $true)][ValidateSet("ingerir", "medir")][string]$Etapa,
  [string]$Base = "https://second-brain.gabriel-fde.workers.dev",
  [int]$Repeticoes = 2
)
$ErrorActionPreference = "Stop"
$aqui = $PSScriptRoot
$linha = Get-Content (Join-Path $aqui "..\..\.dev.vars") | Where-Object { $_ -match "^AUTH_TOKEN=" } | Select-Object -First 1
$tokenDono = ($linha -replace "^AUTH_TOKEN=", "").Trim().Trim('"').Trim("'")
$estado = Get-Content (Join-Path $aqui ".estado-teste.json") -Raw | ConvertFrom-Json
$gab = Get-Content (Join-Path $aqui "gabarito.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$contas = @(@{ nome = "P0 dono"; token = $tokenDono; nivel = 0 }, @{ nome = "P$($estado.nivel) membro"; token = $estado.token; nivel = [int]$estado.nivel })

function Chamar($metodo, $caminho, $token, $corpo) {
  $a = @{ Method = $metodo; Uri = "$Base$caminho"; Headers = @{ Authorization = "Bearer $token" }; ContentType = "application/json; charset=utf-8" }
  if ($null -ne $corpo) { $a.Body = [System.Text.Encoding]::UTF8.GetBytes(($corpo | ConvertTo-Json -Depth 8)) }
  Invoke-RestMethod @a
}
function Tempo($bloco) { $sw = [Diagnostics.Stopwatch]::StartNew(); $r = & $bloco; $sw.Stop(); [pscustomobject]@{ r = $r; ms = [int]$sw.ElapsedMilliseconds } }
function Percentil($valores, $p) {
  $v = @($valores | Sort-Object); if (-not $v.Count) { return 0 }
  $v[[Math]::Min($v.Count - 1, [int][Math]::Ceiling($p / 100 * $v.Count) - 1)]
}
function Config($modo) { Chamar "PATCH" "/config" $tokenDono @{ RERANKER = $modo } | Out-Null }
function Contem($texto, $token) { $texto.IndexOf($token, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
function TextoDoSse($bruto) {
  $partes = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($bruto -split "`n")) {
    if ($l -notmatch "^data:\s*(.+)$") { continue }
    $d = $Matches[1].Trim(); if ($d -eq "[DONE]") { continue }
    try { $o = $d | ConvertFrom-Json } catch { $partes.Add($d); continue }
    $pilha = New-Object System.Collections.Stack; $pilha.Push($o)
    while ($pilha.Count) { $x = $pilha.Pop(); if ($x -is [string]) { $partes.Add($x) } elseif ($x -is [System.Management.Automation.PSCustomObject]) { $x.PSObject.Properties | ForEach-Object { $pilha.Push($_.Value) } } elseif ($x -is [System.Collections.IEnumerable]) { foreach ($y in $x) { $pilha.Push($y) } } }
  }
  ($partes -join "")
}
$docs = $gab.itens | Select-Object -ExpandProperty doc -Unique

switch ($Etapa) {
  "ingerir" {
    $relatorio = New-Object System.Collections.Generic.List[object]
    foreach ($nomeDoc in $docs) {
      $conteudo = Get-Content (Join-Path $aqui $nomeDoc) -Raw -Encoding UTF8
      $arq = @{ path = "teste-permissoes/$nomeDoc"; content = $conteudo; source = "teste-permissoes" }
      # os trechos do servidor são os parágrafos fora de títulos, na ordem do arquivo
      $paragrafos = @(($conteudo -replace "`r`n", "`n") -split "\n\s*\n" | ForEach-Object { ($_ -split "`n" | Where-Object { $_ -notmatch "^#" }) -join "`n" } | Where-Object { $_.Trim() })
      $t = Tempo { Chamar "POST" "/bulk-ingest" $tokenDono @{ files = @($arq); dry_run = $true; workspace = "company" } }
      $chunks = @($t.r.chunks)
      "[$nomeDoc] classificação (dry run): $($t.ms) ms, $($chunks.Count) trechos ($($paragrafos.Count) parágrafos), publicados=$($t.r.published) quarentena=$($t.r.quarantined) revisão=$($t.r.flagged_for_review)"
      if ($chunks.Count -ne $paragrafos.Count) { "   ATENÇÃO: contagem diferente, o mapeamento por posição pode falhar" }
      foreach ($it in ($gab.itens | Where-Object { $_.doc -eq $nomeDoc })) {
        $idx = -1; for ($i = 0; $i -lt $paragrafos.Count; $i++) { if (Contem $paragrafos[$i] $it.token) { $idx = $i; break } }
        if ($idx -lt 0 -or $idx -ge $chunks.Count) { "   token não achado: $($it.token)"; continue }
        $c = $chunks[$idx]
        $situ = if ($c.level -eq $it.nivel) { "exato" } elseif ($c.level -lt $it.nivel) { "mais restrito (seguro)" } else { "MAIS ABERTO" }
        $relatorio.Add([pscustomobject]@{ doc = $nomeDoc; item = $it.token; esperado = $it.nivel; jev = $c.level; conf = $c.confidence; decisao = $c.outcome; motivo = $c.reason; situacao = $situ })
      }
      $g = Tempo { Chamar "POST" "/bulk-ingest" $tokenDono @{ files = @($arq); workspace = "company" } }
      "[$nomeDoc] gravação: $($g.ms) ms, publicados=$($g.r.published) quarentena=$($g.r.quarantined) ja_existiam=$($g.r.already_present)"
    }
    ""
    $relatorio | Format-Table item, esperado, jev, @{ n = "conf"; e = { [Math]::Round([double]$_.conf, 2) } }, decisao, motivo, situacao -AutoSize
    $n = $relatorio.Count
    "Acurácia exata: $(@($relatorio | Where-Object situacao -eq 'exato').Count)/$n   mais restrito (seguro): $(@($relatorio | Where-Object situacao -like 'mais restrito*').Count)/$n   MAIS ABERTO (risco): $(@($relatorio | Where-Object situacao -eq 'MAIS ABERTO').Count)/$n"
    $relatorio | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $aqui "resultado-classificacao.json") -Encoding UTF8
    $v = Tempo { $r = $null; for ($i = 0; $i -lt 8; $i++) { $r = Chamar "POST" "/vectorize-pending" $tokenDono @{}; if (-not $r.remaining) { break } }; $r }
    "vetorização: $($v.ms) ms, restante=$($v.r.remaining)"
  }
  "medir" {
    $consultas = @()
    foreach ($it in $gab.itens) { $consultas += [pscustomobject]@{ tipo = "parafrase"; q = $it.pergunta; token = $it.token; nivel = [int]$it.nivel } }
    foreach ($a in $gab.adversariais) { $consultas += [pscustomobject]@{ tipo = "adversarial"; q = $a; token = $null; nivel = $null } }
    $niveis = @{}; foreach ($it in $gab.itens) { $niveis[$it.token] = [int]$it.nivel }
    function Vistos($texto) { @($gab.itens | Where-Object { Contem $texto $_.token } | ForEach-Object { $_.token }) }

    $linhas = New-Object System.Collections.Generic.List[object]
    foreach ($modo in @("off", "jev")) {
      Config $modo
      foreach ($conta in $contas) {
        foreach ($c in $consultas) {
          for ($rep = 1; $rep -le $Repeticoes; $rep++) {
            $t = Tempo { Chamar "GET" ("/recall?full=1&query=" + [uri]::EscapeDataString($c.q)) $conta.token $null }
            $res = @($t.r.results)
            $rank = 0; $vistos = New-Object System.Collections.Generic.HashSet[string]
            for ($i = 0; $i -lt $res.Count; $i++) {
              $txt = [string]$res[$i].content
              foreach ($tok in (Vistos $txt)) { [void]$vistos.Add($tok) }
              if ($c.token -and $rank -eq 0 -and (Contem $txt $c.token)) { $rank = $i + 1 }
            }
            $vazou = @($vistos | Where-Object { $niveis[$_] -lt $conta.nivel }).Count
            $linhas.Add([pscustomobject]@{
              modo = $modo; conta = $conta.nome; contaNivel = $conta.nivel; tipo = $c.tipo; q = $c.q; token = $c.token; nivelItem = $c.nivel; rep = $rep
              ms = $t.ms; rerankMs = $t.r.reranker.ms; reranked = [bool]$t.r.reranked; degradado = $t.r.reranker.degraded
              n = $res.Count; rank = $rank; vazou = $vazou; vistos = ($vistos -join "|")
            })
          }
        }
      }
    }
    Config "jev"
    $linhas | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $aqui "resultado-recall.json") -Encoding UTF8

    ""; "=== 1. Vazamento (trechos de nível mais restrito que o da conta, em qualquer resposta) ==="
    $linhas | Group-Object conta | ForEach-Object { "{0,-14} consultas={1,3}  vazamentos={2}" -f $_.Name, $_.Count, ($_.Group | Measure-Object vazou -Sum).Sum }

    ""; "=== 2. Tempo do /recall, medido no cliente (ms) ==="
    $linhas | Group-Object modo, conta | ForEach-Object { $v = $_.Group.ms; "{0,-24} n={1,3} p50={2,5} p95={3,5} max={4,5} media={5,5}" -f $_.Name, $v.Count, (Percentil $v 50), (Percentil $v 95), ($v | Measure-Object -Maximum).Maximum, [int](($v | Measure-Object -Average).Average) }
    $j = @($linhas | Where-Object { $_.modo -eq "jev" })
    $rr = @($j | Where-Object reranked)
    "reranker no servidor: reranked=$($rr.Count)/$($j.Count) degradadas=$(@($j | Where-Object { $_.degradado }).Count) p50=$(Percentil $rr.rerankMs 50) ms p95=$(Percentil $rr.rerankMs 95) ms max=$(($rr.rerankMs | Measure-Object -Maximum).Maximum) ms"

    ""; "=== 3. Qualidade da busca, conta P0, perguntas parafraseadas (rep 1) ==="
    foreach ($modo in @("off", "jev")) {
      $s = @($linhas | Where-Object { $_.modo -eq $modo -and $_.conta -like "P0*" -and $_.tipo -eq "parafrase" -and $_.rep -eq 1 })
      $top1 = @($s | Where-Object { $_.rank -eq 1 }).Count; $top3 = @($s | Where-Object { $_.rank -ge 1 -and $_.rank -le 3 }).Count; $ach = @($s | Where-Object { $_.rank -ge 1 }).Count
      $mrr = [Math]::Round((($s | ForEach-Object { if ($_.rank -ge 1) { 1.0 / $_.rank } else { 0 } } | Measure-Object -Sum).Sum / $s.Count), 3)
      "reranker=$modo : top1=$top1/$($s.Count)  top3=$top3/$($s.Count)  achou=$ach/$($s.Count)  MRR=$mrr"
    }

    ""; "=== 4. Isolamento por pergunta: o membro P$($estado.nivel) (reranker jev, rep 1) ==="
    $s = @($linhas | Where-Object { $_.modo -eq "jev" -and $_.conta -like "P$($estado.nivel)*" -and $_.tipo -eq "parafrase" -and $_.rep -eq 1 })
    $certo = 0
    foreach ($x in $s) {
      $deve = $x.nivelItem -ge $estado.nivel; $viu = ($x.rank -ge 1)
      $ok = if ($deve) { $viu } else { -not $viu }; if ($ok) { $certo++ }
      "{0,-4} item=P{1,-2} deveVer={2,-5} viu={3,-5} {4}" -f $(if ($ok) { "ok" } else { "FALHA" }), $x.nivelItem, $deve, $viu, $x.q.Substring(0, [Math]::Min(60, $x.q.Length))
    }
    "Decisões corretas do membro: $certo/$($s.Count)"
    $dono = @($linhas | Where-Object { $_.modo -eq "jev" -and $_.conta -like "P0*" -and $_.tipo -eq "parafrase" -and $_.rep -eq 1 -and $_.rank -ge 1 }).Count
    "O dono encontrou o trecho certo em $dono/$($s.Count) perguntas"

    ""; "=== 5. Chat ponta a ponta (recall + resposta do LLM): tempo e vazamento ==="
    $chat = @($gab.itens | Where-Object { $_.token -in @("31 milhões", "8.100", "1,87", "grupo espanhol", "dois dias úteis", "Uma serra inteira") })
    foreach ($conta in $contas) {
      foreach ($it in $chat) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $rec = Chamar "GET" ("/recall?full=1&query=" + [uri]::EscapeDataString($it.pergunta)) $conta.token $null
        $mem = (@($rec.results) | ForEach-Object -Begin { $i = 0 } -Process { $i++; "[$i] " + $_.content }) -join "`n`n"
        $ids = @(@($rec.results) | ForEach-Object { $_.id })
        $web = Invoke-WebRequest -Method Post -Uri "$Base/chat" -Headers @{ Authorization = "Bearer $($conta.token)" } -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ query = $it.pergunta; memories = $mem; memory_ids = $ids } | ConvertTo-Json -Depth 5)))
        $sw.Stop()
        $resp = TextoDoSse ([System.Text.Encoding]::UTF8.GetString($web.RawContentStream.ToArray()))
        $vistos = Vistos $resp
        $vz = @($vistos | Where-Object { $niveis[$_] -lt $conta.nivel }).Count
        $acertou = Contem $resp $it.token
        "{0,-12} {1,6} ms  modelo={2,-34} citou-o-item={3,-5} vazou={4}  P{5} :: {6}" -f $conta.nome, [int]$sw.ElapsedMilliseconds, $web.Headers["X-LLM-Model"], $acertou, $vz, $it.nivel, $it.pergunta
      }
    }
  }
}

# Auditoria do monitoramento de saúde — 2026-09-17 (v1.83.3)

> **STATUS — HISTORICAL: registro do estado em v1.83.3.** Os OITO achados abaixo foram
> corrigidos na v1.84.0, no mesmo PR que trouxe este relatório. Leia como a medição que
> motivou a mudança, não como fila de trabalho; as MEDIÇÕES (bytes varridos, estado do
> heartbeat, fontes no `gold_source_metadata`) são o retrato de 2026-09-17.
> Guardas novos: a varredura `test_no_probe_raises_on_a_malformed_env` sobre TODAS as
> sondas, `test_every_bigquery_read_in_doctor_is_capped` (estático, via `ast`),
> `test_expected_metadata_sources_match_the_dbt_model`,
> `test_serving_targets_match_the_dbt_serving_models`, e a coluna `period_end` em
> `gold_source_metadata`. O que cada correção fez está na seção final.

Auditoria pedida sobre **a lógica que monitora a saúde do sistema**: as cinco superfícies que
respondem, juntas, "o pipeline está vivo e o dado está chegando?".

| superfície | pergunta que responde | onde |
|---|---|---|
| `embrapa doctor` (29 checks) | o ambiente e o acervo estão sãos? | `src/embrapa_dashboard/doctor.py` |
| Ingest heartbeat | o **gatilho** disparou? | `src/embrapa_dashboard/ingestion_heartbeat.py` + `doctor._check_ingest_heartbeat` |
| `dbt source freshness` | o **dado** ainda chega? | `.github/workflows/dbt-source-freshness.yml` + `dbt/models/_sources.yml` |
| Alerta Cloud Monitoring | o **Job** quebrou? | `deploy/ingestion/alert.sh` + `alert_policy.json` |
| `embrapa monitor` | o que está acontecendo AGORA numa execução? | `src/embrapa_dashboard/monitor/` + `observability.py` |

**Fora de escopo:** a tela *Saúde* do dashboard (`frontend/src/ui/ViewHealth.jsx`) e
`serving_quality_by_source` — são saúde **do dado** para o pesquisador, não do sistema.

**Veredito: a arquitetura está certa e os buracos conhecidos estão tapados.** As três
perguntas ortogonais (gatilho · dado · crash) estão cada uma com o seu instrumento, e a
razão de cada janela está escrita ao lado dela. Os achados abaixo não são omissões de
desenho — são **pontos onde o instrumento afirma mais do que mediu**, que é a única classe
de defeito que importa num monitor: um vermelho falso irrita, um verde falso desliga a
vigilância.

Todo número aqui foi medido hoje contra o prod (`embrapa-dashboard-commodities`) ou
reproduzido localmente; os comandos estão inline.

---

## 🔴 A1 — Um `.env` malformado derruba o `doctor` inteiro, e é o caso que ele existe para diagnosticar

Duas sondas executam código **fora** do próprio `try`, e `run_all` não tem guarda:

* `doctor.py:689` — `_check_comex` lê `settings.comex_flows_list` antes do `try`. A property
  levanta `ValueError` em `COMEX_FLOWS` vazio ou inválido (`config.py:825-836`).
* `doctor.py:586-589` — `_check_bcb` captura apenas `StopIteration`; `inflation_series_map`
  levanta `ValueError` num par sem `:` (`_parse_code_label`).
* `doctor.py:1532` — `run_all` é uma list-comprehension nua; `cli.py:1198` também não guarda.

Reproduzido:

```
$ python -c "... Settings(comex_flows=''); doctor.run_all(s)"
_check_env  -> False                       # a linha que JÁ diagnosticou o problema
run_all RAISED ValueError: COMEX_FLOWS is empty.   -> a tabela nunca é impressa
```

Como os resultados são coletados antes de qualquer impressão, o operador recebe um
traceback e **nenhuma** das 29 linhas — inclusive o `.env parsed ✗` que responderia a
pergunta dele. Mesma reprodução com `BCB_INFLATION_SERIES=433_no_colon`.

O invariante está escrito no próprio suite — `tests/test_doctor.py:1181` *"A probe must
never raise INTO run_all — one broken check would take down the whole report, which is the
opposite of what a health command is for"* — mas é verificado para **uma** sonda
(`_check_silvicultura_variable_codes`). As duas que o violam não são testadas nesse eixo, e
`test_run_all_executes_every_probe` mocka tudo, então nunca exercita o caminho.

**Correção.** Guarda em `run_all` (`try/except` por sonda → `_skip_ou_quebra`), mover o corpo
das duas sondas para dentro do `try`, e um teste parametrizado sobre **todas** as sondas com
um `Settings` quebrado — o invariante já está redigido, falta ser varrido.

---

## 🔴 A2 — "Ingest heartbeat" ignora `outcome`: uma fonte que falha toda semana lê verde

A consulta do check é (`doctor.py:1149-1151`):

```sql
select source, max(run_ts) as last_run from `...ingestion_heartbeat` group by source
```

Sem filtro de `outcome`. Mas o docstring do módulo que ESCREVE a tabela define três estados
(`ingestion_heartbeat.py:14-18`): sem linha = gatilho morto · `ok` = rodou · `failed` =
rodou e quebrou. O check lê os dois primeiros e descarta o terceiro — a evidência está na
tabela e é jogada fora.

Isso seria inofensivo se o alerta cobrisse o `failed`. Ele não cobre, **por decisão
deliberada**: `ingest all` sai **0** quando toda falha é `SourceTransientError`
(`cli.py:922-935`), justamente para não paginar por algo auto-curável. Então:

| situação | heartbeat | alerta Cloud Monitoring | dbt freshness |
|---|---|---|---|
| fonte falha transiente **toda** semana, para sempre | 🟢 "ran inside its window" | 🔇 exit 0, não dispara | 🚨 só onde há `error_after` |

Para `ibge-pam`, `ibge-ppm` e `comtrade` o freshness é **warn-only** (60 d, sem
`error_after` — `_sources.yml:50,66,157`), então nada falha em lugar nenhum. As três camadas
concordam que está tudo bem porque cada uma delegou essa pergunta à outra.

**Estado real, medido hoje** — nada está mascarado agora:

| source | ok | failed | última | dias |
|---|---|---|---|---|
| bcb-currency | 24 | 0 | hoje | 0 |
| bcb-inflation | 4 | 0 | | 3 |
| comex | 3 | 0 | | 3 |
| foreign-inflation | 1 | 0 | | 3 |
| ibge | 3 | 0 | | 3 |
| ibge-silvicultura | 5 | 0 | | 3 |
| ibge-pam | 1 | 0 | | 15 |
| ibge-ppm | 1 | 0 | | 14 |
| **comtrade** | — | — | **nunca** | — |

`comtrade` (cadência 31 d + 3 de folga = janela 34 d) está corretamente em `pending`: a
tabela tem 20 dias de vida, menos que a janela. Em ~15 dias vira "nunca rodou" — o check
funcionando como projetado.

**Correção.** Basear a janela em `max(if(outcome='ok', run_ts, null))` e reportar `last_run`
e `last_ok` separadamente: "rodou há 3 d, mas o último sucesso foi há 47 d" é a frase que
falta hoje.

---

## 🟡 A3 — "Source data freshness" diz *every source current* sobre o subconjunto que apareceu

`gold_source_metadata` termina cada bloco com `having count(*) > 0`
(`gold_source_metadata.sql:35`) — **uma fonte vazia não emite linha**. O check itera as
linhas que voltaram e não tem expectativa de QUAIS fontes deveriam estar lá; o único guarda
é `if not rows`, que só pega o caso em que *todas* sumiram.

Probe (1 de 5 fontes presente):

```
B só 1 das 5 fontes presente -> True | every source current: mdic_comex=2026 (annual slack=2y)
```

Um `--full-refresh` que esvaziasse `gold_pevs_production` apaga o PEVS do relatório e o
relatório diz que está tudo em dia.

É exatamente a lição já aprendida no check vizinho, 110 linhas abaixo, e não propagada:
*"Never say 'every' over the subset that happens to have reported"* (`doctor.py:1205`). O
heartbeat itera `INGESTS` — um conjunto **declarado**; o freshness itera o resultado.

**Correção.** Comparar contra as chaves declaradas (as de `sqlbuild.GOLD_CODE_SOURCES`
servem) e nomear as ausentes como o achado mais alto do check.

*(Verificado: as 5 fontes estão presentes em prod hoje — `ibge_pam`, `ibge_pevs`,
`ibge_ppm` e `un_comtrade` anuais até 2024/2025, `mdic_comex` mensal até 2026. O achado é
latente.)*

---

## 🟡 A4 — A janela "monthly" é de 13 a 24 meses, não do ~1 mês que o comentário promete

`doctor.py:1088-1093`:

```python
# 'monthly' sources should always carry the current year — except in January,
# when the newest closed month can still belong to the previous one (COMEX is D+30).
floor = this_year - (slack if cadence == "annual" else 1)
```

O comentário descreve uma tolerância de **um mês**; o código concede **o ano anterior
inteiro**, o ano todo. `year_end` é um ANO (`max(reference_year)`), então o mês não existe
nessa comparação.

Consequência exata: uma fonte mensal que para de publicar no mês M do ano Y mantém
`year_end = Y`, e o `floor` só passa de Y em **janeiro de Y+2** — detecção entre **13 e 24
meses** depois. Probe, em setembro de 2026:

```
A monthly parado em 2025 -> True | every source current: mdic_comex=2025 (annual slack=2y)
```

O teste que parece fixar isso
(`test_source_freshness_holds_monthly_sources_to_a_tighter_floor`) usa `year - 2`, então o
comportamento em `year - 1` — o caso real — nunca foi pinado. A folga mensal também é a
única não configurável: `source_freshness_annual_slack_years` só toca o ramo anual.

**Correção.** `gold_comex_flows` já carrega `reference_month` e `reference_date` (é a coluna
de partição, `gold_comex_flows.sql:4,63`). Expor `max(reference_date)` em
`gold_source_metadata` e medir a defasagem mensal em meses.

---

## 🟡 A5 — Instalação fria pinta de vermelho justamente os dois checks que leem tabelas criadas preguiçosamente

`_check_source_data_freshness` e `_check_ingest_heartbeat` terminam em
`except Exception → ok=False` (`doctor.py:1111`, `doctor.py:1212`). Probe:

```
C gold_source_metadata inexistente -> False | 404 Table gold_source_metadata not found
D heartbeat inexistente            -> False | 404 Table ingest_heartbeat not found
```

`doctor` sai 1. Mas as duas tabelas são criadas preguiçosamente — `gold_source_metadata` no
primeiro `dbt build`, `ingest_heartbeat` na primeira ingestão (`ingestion_heartbeat.py:98`)
— então **todo projeto novo começa com dois ✗ que não significam nada**, e é assim que um
operador aprende a ignorar o `doctor`.

O mecanismo para isso já existe e está documentado com o incidente que o motivou:
`_skip_ou_quebra` (`doctor.py:54-81`) separa "sem dado para julgar" (verde, `skipped:`) de
"check quebrado" (vermelho). Está aplicado em 6 dos 29 checks — e **não** nestes dois, que
são os dois que leem tabelas que podem legitimamente não existir.

**Correção.** Trocar o `except` dessas duas sondas por `_skip_ou_quebra`. Uma linha cada.

---

## 🟡 A6 — `doctor` não tem teto de bytes: ~362 MB varridos por execução

Medido por `dryRun` contra o prod hoje:

| check | MB varridos |
|---|---|
| Source data freshness (`gold_source_metadata`) | **171,7** |
| Catalog → Gold arrival | 67,8 |
| Catalog orphan lifecycle | 67,8 — **a mesma união, recomputada** |
| Shared code across SIDRA tables (pevs + ppm) | 54,8 |
| **total por `embrapa doctor`** | **≈ 362 MB** |

Job real do primeiro: `totalBytesBilled: 171.966.464`, `totalSlotMs: 54.668`. O mecanismo é
que `gold_source_metadata` é uma **view** que calcula `count(*)`, três `count(distinct …)`,
`min`/`max` e o gate de visibilidade sobre as cinco tabelas Gold (9,85 M linhas, 2,4 GB) —
pedir 3 colunas dela custa a view inteira.

Nenhuma das consultas de `doctor.py` passa `maximum_bytes_billed`. O teto existe
(`Settings.bq_max_bytes_billed`, 100 GiB) e é aplicado no `gateway` e no `catalog_resolver`
— nunca aqui. Hoje 362 MB é modesto; o que falta é o **limite**, num comando que o operador
roda repetidamente enquanto depura e cujo custo cresce com o acervo.

Isso não é hipotético neste projeto: o `dbt build` de prod foi cortado de diário para 2×
por semana em 2026-08-26 por ser **98,9% dos bytes faturados**.

**Correção.** (a) `job_config.maximum_bytes_billed = settings.bq_max_bytes_billed` em todo
`bq.query` de `doctor`; (b) computar a união de códigos Gold **uma vez** e passá-la aos dois
checks que hoje a repetem (−67,8 MB); (c) para o freshness, ler as três colunas de uma
projeção enxuta em vez da view completa.

---

## 🟢 A7 — `SERVING_TARGETS` é o único registro sem teste de paridade

`SOURCE_CHECKS` e `BRONZE_TARGETS` têm teste de paridade contra `cli.INGESTS`
(`test_doctor.py:752-799`), com o mapa de nomes explicitado como contrato. `SERVING_TARGETS`
— o gate de prontidão de deploy da camada de dados — não tem nenhum: `grep -rn
SERVING_TARGETS tests/` não retorna nada.

Hoje está **correto**: os 7 modelos em `dbt/models/serving/` batem exatamente com as 7
entradas. Nada trava isso, então a 8ª mart nasce fora do gate em silêncio.

**Correção.** Um teste que lista `dbt/models/serving/*.sql` e compara com `SERVING_TARGETS`,
com a exclusão deliberada de `dim_code_industrialization_scd2` (gated por `enable_curation`)
declarada como allowlist.

---

## 🟢 A8 — "~10 segundos" é falso no caso ruim, que é o único em que alguém cronometra

Afirmado três vezes: `doctor.py:5` ("~10 seconds"), `doctor.py:30-31` ("the whole `embrapa
doctor` should finish in under ~15s even when something is broken") e `cli.py:1185`.

Contagem real das sondas de rede, sequenciais, com `PROBE_TIMEOUT_S = 10`: ibge 1 ·
silvicultura 1 · pam 1 · ppm 2 · bcb 1 · foreign-inflation 2 · comex 1–2 · comtrade 1 =
**10–11 requisições → 100–110 s** só de rede, mais os ~362 MB de BigQuery de A6 (54,7 s de
slot só no primeiro check). O `timeout` do `requests` é por operação de socket, não total,
então um servidor lento pode passar de 10 s por requisição.

**Correção.** Corrigir o texto, ou paralelizar as sondas de rede — são independentes e não
compartilham estado.

---

## 🟢 Conforme — verificado, sem ação

| item | por que passa |
|---|---|
| Separação das três perguntas | gatilho (heartbeat) · dado (freshness) · crash (alerta) são instrumentos distintos, cada um com o seu limite declarado no docstring |
| `ingestion_heartbeat.record` nunca derruba a ingestão | `except Exception` → warning; `NotFound` cria a tabela e tenta uma vez. *"A monitor that can take down the thing it monitors is worse than no monitor"* |
| Heartbeat: exempção de "nunca reportou" | limitada por `watched_days` (a idade da própria tabela), então o silêncio deixa de ser desculpa quando passa a significar algo |
| `cadence_days` ↔ cron | `test_ingest_cadence_matches_schedulers.py` lê o CRON default de cada `schedule*.sh` e exige que toda fonte tenha gatilho |
| Janelas do `dbt source freshness` | recalibradas quando a batch virou semanal (10 d/17 d), com a medição que motivou cada uma no comentário; `bcb-currency` mantido em 2 d/7 d por ter gatilho diário próprio |
| Alerta Cloud Monitoring | um Job compartilhado por vários gatilhos, e a `documentation` do policy diz como descobrir qual rodou (`containerOverrides.args`) |
| Exit 0 em falha transiente | decisão correta e documentada — não paginar por algo auto-curável. É o **A2** que deixa de compensá-la, não ela que está errada |
| `_skip_ou_quebra` | a distinção certa (sem dado ≠ check quebrado), com o incidente que a motivou registrado; advisory quebrado também fica vermelho, de propósito |
| `_redact` | a chave do BLS viaja na query string e `requests` põe a URL na mensagem de exceção; redige antes de truncar |
| Sondas que não confiam no 200 | BLS responde recusa de quota com HTTP 200 + status no corpo; ECB responde 200 com corpo vazio. As duas são verificadas |
| `_latest_complete_run` | exige o `_SUCCESS` **e** que o dataset gravado no manifesto bata com o configurado — um snapshot de dev não satisfaz um gate de prod |
| `observability.py` | `FileHandler` simples de propósito (rotação renomearia o arquivo sob o tail por offset do monitor); glob→stat com corrida tratada |
| `monitor/` | separado em `state` (sem Rich, testável) e `render`; tabela de despacho no lugar de if/elif |
| Suite | 239 testes verdes nos 7 arquivos de monitoramento (`pytest … -q`, 14,8 s) |

---

## O que foi corrigido (v1.84.0)

| achado | correção |
|---|---|
| **A1** | `run_all` guarda cada sonda e devolve a linha via `_skip_ou_quebra` — uma sonda que explode custa a PRÓPRIA linha, com o nome da chave de registro (o nome de exibição mora dentro da sonda, que é justamente quem não consegue fornecê-lo). `_check_comex` e `_check_bcb` passaram o corpo para dentro do `try`. O invariante virou varredura sobre TODAS as sondas × 7 formas de `.env` quebrado. |
| **A2** | A janela passa a medir o último **sucesso** (`max(if(outcome='ok', run_ts, null))`). Um terceiro diagnóstico entrou na linha — *"roda mas não conclui"* — separado de *"parou de rodar"* e *"nunca rodou"*, porque o conserto é outro: os logs da execução, não o Cloud Scheduler. |
| **A3** | `_EXPECTED_METADATA_SOURCES` declara as cinco fontes; uma ausente vira o achado que LIDERA a linha, e a frase só diz "every expected source current" depois de conferir o conjunto. Um teste lê `gold_source_metadata.sql` e falha se as duas listas divergirem. |
| **A4** | `gold_source_metadata` ganhou `period_end` (DATE): 31/12 do `year_end` nas anuais, `last_day(max(reference_date))` no COMEX. A fonte mensal é medida em MESES, com folga própria (`SOURCE_FRESHNESS_MONTHLY_SLACK_MONTHS`, default 3). Detecção cai de 13–24 meses para ~4. |
| **A5** | `_skip_ou_quebra` nos dois checks que leem tabelas criadas preguiçosamente. Instalação fria deixa de sair 1 com dois `✗ 404`. |
| **A6** | `_bq_job_config` aplica `maximum_bytes_billed` às **sete** leituras BigQuery do módulo, travado por um teste estático que percorre o `ast` atrás de um `.query()` sem `job_config`. A união de códigos Gold virou um helper só. O volume varrido não muda; o que muda é que uma varredura ilimitada deixa de ser representável. |
| **A7** | Teste de paridade entre `dbt/models/serving/*.sql` e `SERVING_TARGETS`, com `dim_code_industrialization_scd2` como exclusão declarada. |
| **A8** | As três afirmações de "~10 segundos" saíram; o módulo agora declara o custo real (~100 s de rede no caso ruim + ~362 MB de scan) e um teste impede o retorno da promessa. |

Nada disto era urgente quando foi escrito: as oito fontes estavam dentro da janela, com zero
`failed` registrado e as cinco fontes presentes no `gold_source_metadata`. Eram achados sobre
o que o monitor **deixaria de ver** — e é por isso que foram corrigidos antes de precisarem.

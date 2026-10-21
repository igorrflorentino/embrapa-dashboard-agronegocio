# Protótipo: deflação pelo índice médio do ano — 2026-10-21

> **STATUS — PROTÓTIPO EM DEV, NADA EM PRODUÇÃO, DECISÃO PENDENTE.** A variável nasce desligada
> (`inflation_year_basis: year_end`) e, desligada, o SQL compilado é **byte a byte o de antes**.
> Este documento mede o que a opção (b) da auditoria `unidades_e_deflacao_audit_2026-10-21.md`
> (PR #538) faria, contra a produção, para o Igor decidir com números.

## Resumo para quem decide

1. **A mecânica funciona e é exata.** Com a regra nova, cada valor corrigido de PAM, PEVS e PPM muda
   exatamente pela razão dezembro ÷ média do índice (diferença de 10⁻¹⁵ nos 52 anos). Não há efeito
   colateral escondido no valor.
2. **Ela remove o degrau de 1993→1994, mas não cura a série.** A mediana do salto 1993→94 cai de ×3,77
   para ×1,71 (PAM), de ×2,27 para ×1,03 (PEVS) e de ×2,15 para ×0,97 (PPM); nenhuma série passa de 3×
   (eram 11). Mas parte do movimento **muda de ano** em vez de sumir (1994→95 passa de ~0,9–1,0 para
   0,65–0,72), e a aspereza média de 1987–96 só cai 32% na PAM, 14% no PPM e **3% no PEVS**.
3. **Custa**: todo `val_real_*` de IBGE antes de 1995 muda (×1,15 a ×3,5); **depois de 1995 também,
   em até 17%** (IGP-DI em 2002) — e **corrijo aqui um erro da auditoria**, que dizia "até 8%";
   o IGP-M deixa de ter valor em 1989 (746 linhas a menos nos três bancos somados); e o
   alarme de deriva do `doctor` **vai disparar** (3 etiquetas) numa reconstrução, como numa mudança
   deliberada da taxonomia.
4. **Minha recomendação**: adotar (b) **junto com** o aviso (a), e escrever o aviso para o período
   inteiro 1986–1994, não só para 1994, porque a série corrigida desses anos continua indicativa.
   A decisão é sua: muda números que pesquisadores já podem ter citado.

## O que o protótipo faz

`dbt/macros/annual_deflation_ctes.sql` (usada por `gold_pam/pevs/ppm_production` e
`gold_comtrade_flows`) escolhe o índice que deflaciona um ano pela variável `inflation_year_basis`:

| valor | índice do ano | status |
|---|---|---|
| `year_end` (padrão) | o de **dezembro** | comportamento de produção, intocado |
| `year_avg` | a **média** dos índices mensais do ano | protótipo |

- A regra `year_avg` só vale para o ano em que o índice cobre **12 meses**, exceto o **último ano da
  série** (ainda aberto, usa a média dos meses presentes). Uma série que começa no meio do ano
  (IGP-M, 1989-06) fica **sem valor** nesse primeiro ano, em vez de uma média sobre a parte do ano que
  cobre. A lacuna aparece na tela sozinha, porque o `valueGap` é medido nos **dados** (contagem de
  valores nulos por ano), não no primeiro ano do índice: nenhum código Python precisa mudar.
- Vale para as **cinco** séries (IPCA, IGP-M, IGP-DI, CPI-U, HICP) com uma só regra.
- O **COMEX não é afetado**: ele é mensal e já deflaciona pelo índice do **próprio mês**
  (`inflation_month` em `gold_comex_flows`).
- Valor inválido da variável derruba a compilação com mensagem clara.

Por que a média é o estimador certo: um valor anual é um **fluxo**. Se o volume real é o mesmo todo
mês, o valor nominal de cada mês é proporcional ao índice do mês, e a soma é `q × Σ índice`; o valor
real é então `soma ÷ média do índice`. O índice de dezembro só serve quando dezembro e a média
coincidem (baixa inflação).

## Provas

- **Padrão = antes, no SQL.** Compilei os quatro modelos com a macro de `main` e com a nova (variável
  no padrão): **byte a byte idênticos**.
- **Padrão = antes, nos dados (controle).** `gold_pam_production` construído em dev com o padrão: todas
  as colunas de valor corrigido em R$ (IPCA, IGP-M, IGP-DI), as quantidades e `data_quality_flag` são
  **idênticos** aos de produção; as quatro colunas que dependem do câmbio diferem em no máximo
  **4–6×10⁻¹⁶** (o último bit do `avg()` do câmbio, não determinístico). Isso também prova que a
  produção está em dia com a inflação, então a comparação com `year_avg` isola o efeito da regra.
- **Testes unitários** (`_gold.yml`): três novos, com aritmética exata (IPCA 10…120, "hoje" 195: dezembro
  dá 1.625, a média dá 3.000; ano de 6 meses fora do último fica sem valor; o último ano aberto usa a
  média dos meses presentes). Os dois testes que dependem da regra de dezembro agora a **fixam**
  (`overrides: vars`), porque uma execução com `--vars inflation_year_basis: year_avg` os quebrava
  (achado do primeiro build). **Contraprova:** com a macro antiga, os dois testes de `year_avg` falham
  e o de dezembro passa.
- **Build em dev** (`year_avg`; Gold de PAM, PEVS, PPM e COMTRADE, cinco marts de serving e todos os
  seus testes): `PASS=121 WARN=2 ERROR=0`. Os dois avisos são a linha de base e não leem valor
  corrigido (`assert_pam_area_planted_ge_harvested`, `assert_unconvertible_quantities_for_curation`).
  Os tetos de `assert_pre1994_real_per_unit_bounded` e `assert_pam_pre1994_real_per_unit_bounded`
  aguentam valores pré-1995 maiores.

## Medido: dev (média) × produção (dezembro)

### 1. O efeito mecânico

Razão dev ÷ prod do total nacional (IGP-DI; igual nos três bancos e igual a dezembro ÷ média):

| ano | 1986 | 1987 | 1988 | **1989** | 1990 | 1991 | 1992 | **1993** | 1994 | 1995 | 1996 | 1999 | **2002** | 2020 | 2025 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| × | 1,15 | 1,82 | 2,64 | 3,49 | 1,94 | 2,19 | 2,52 | 3,21 | 1,46 | 1,05 | 1,03 | 1,08 | 1,17 | 1,13 | 0,99 |

> **Correção da auditoria do #538.** Lá está escrito que "de 1995 em diante" a razão fica entre 1,0×
> e 1,08×. Estava **errado**: eu só tinha olhado até 1998. Em 2002 (1,166) e 2020 (1,129), anos de forte
> desvalorização, o IGP-DI passa de 1,10; o IPCA chega a 1,09 em 1995. O erro está nos textos do #538 e
> foi corrigido na branch dele.

Na COMTRADE (2000–2025), o total mundial muda entre 0,994 e **1,166** (IGP-DI), 1,013 e 1,076 (IPCA),
0,976 e 1,029 (CPI-U) e 1,000 e 1,032 (HICP).

**Cobertura.** O IGP-M perde 1989: **−351** linhas na PAM, **−233** no PEVS, **−162** no PPM; IPCA e
IGP-DI não perdem nenhuma. Na tela o IGP-M passa a começar em 1990.

### 2. O degrau 1993→1994 e a aspereza da série

Mediana, entre produtos, da razão do preço corrigido (IGP-DI por unidade) ano a ano:

| banco | caso | 1992÷91 | 1993÷92 | **1994÷93** | 1995÷94 | 1996÷95 |
|---|---|---:|---:|---:|---:|---:|
| PAM | antes | 0,89 | 0,69 | **3,77** | 0,91 | 0,94 |
| PAM | depois | 1,03 | 0,88 | **1,71** | 0,65 | 0,92 |
| PEVS | antes | 0,87 | 1,13 | **2,27** | 0,98 | 1,02 |
| PEVS | depois | 1,00 | 1,44 | **1,03** | 0,71 | 1,00 |
| PPM | antes | 0,82 | 1,00 | **2,15** | 1,00 | 0,94 |
| PPM | depois | 0,95 | 1,27 | **0,97** | 0,72 | 0,93 |

Séries com salto ≥ 3× em 1994÷93: PAM **9 → 0** (de 13), PEVS **2 → 0** (de 9), PPM 0 → 0. A soja
(R$/t): 1993 de 420 para 1.348, 1994 de 1.737 para 2.533, salto ×4,14 → ×1,88.

**A leitura honesta:** o artefato grande some, mas a série **não fica plana**. Dois movimentos novos
aparecem: **1995÷94 cai para ~0,65–0,72** nos três bancos, e **1993÷92 sobe no PEVS e no PPM**
(1,13 → 1,44 e 1,00 → 1,27). Há duas explicações possíveis, **ambas hipóteses que esta medição não
testa**: o movimento ser real (preços agrícolas em alta em 1994 e em queda em 1995, com o Real
valorizado) ou ser o que a média não captura (uma colheita concentrada no 2º trimestre, onde o índice
de 1994 ainda estava baixo, pesa menos do que a média supõe). **A medição não separa as duas.** Para
saber se a série ficou melhor no agregado, medi a aspereza (média de |ln(preço_t ÷ preço_t−1)| por produto, mediana entre produtos):

| banco | 1987–96 (inflação alta) antes → depois | 1998–2007 (calma, referência) antes → depois |
|---|---|---|
| PAM | 0,430 → **0,293** (−32%) | 0,145 → 0,140 |
| PEVS | 0,423 → **0,410** (−3%) | 0,128 → 0,116 |
| PPM | 0,263 → **0,225** (−14%) | 0,070 → 0,065 |

A série de 1987–96 continua **2 a 3 vezes mais áspera** que a de uma época calma (PAM 0,29 contra 0,14).
Parte é real (planos econômicos, preços relativos em inflação de 20% ao mês) e parte é o que o valor
anual não permite resolver. Conclusão: a opção (b) **corrige um viés mecânico conhecido e de sinal
claro**, mas **não torna a correção pré-1995 confiável**.

### 3. O detector de qualidade **muda** (eu esperava quase nada)

Linhas que trocam de `data_quality_flag`: PAM **37.024** (1,11%), PEVS **13.394** (0,97%), PPM
**14.789** (0,41%). A grande maioria é `UNSCORED → OK` (34.774 / 12.583 / 12.697): o piso de
materialidade (`quality_value_floor`, R$ 100.000) é medido em R$ **reais**, e valores maiores passam a
alcançá-lo — **metade pré-1995, metade depois**. Para as de antes de 1995 a causa é direta (o valor
corrigido sobe). Para as de depois, a causa provável é que o preço mediano de referência de cada
produto, calculado sobre todos os anos, sobe junto; **não isolei isso**. Em qualquer caso o detector
**examina mais linhas**, o que é coerente com a auditoria da v1.90.0 (a lacuna do deflator deixava
linhas sem base para avaliar).

O que mais muda: **1989** tem mais `OUTLIER_*` (parcela das linhas pontuadas: PEVS 1,53% → 3,32%,
PPM 1,98% → 3,00%, PAM 0,94% → 1,29%), e `PROBLEMATIC_VALUE` da PAM vai de 28 para **6** linhas
(23 linhas de 1989 passam a `OK`, o que é compatível com falsos positivos do viés, mas não verifiquei
uma a uma). Nos outros anos amostrados (1990, 1994, 1995, 1999) a parcela varia menos de 0,3 p.p.; as
exceções medidas são 1986 (PEVS 2,30% → 1,71%), 1989 e 1993 (PEVS 0,70% → 1,00%).

**O `quality-drift` do `doctor` dispararia** numa reconstrução (3 etiquetas): `PROBLEMATIC_VALUE` da PAM
(28 → 6, ÷4,7) e, no PEVS, a parcela **por valor** de `OK` (−5,0 p.p.) e de `OUTLIER_VALUE` (+5,0 p.p.).
Este último é efeito do peso: a parcela por valor pondera cada linha pelo valor **corrigido**, e é isso
que a mudança mexe. Seria a quinta mudança deliberada que o alarme registra (v1.17, v1.49, v1.73,
v1.90): o aviso é esperado e deve ir no CHANGELOG, mas **não é um defeito**.

### 4. Os deflatores estrangeiros: ficaram na mesma regra

Dezembro ÷ média do CPI-U vai de 0,976 a 1,029 (média 1,005) e a do HICP de 1,000 a 1,032 (1,009),
em 1996–2025. O protótipo aplica **uma regra única** às cinco séries: dizer "o deflator do ano é a
média dos seus meses" para todos é mais simples de documentar e de defender do que duas regras. O
custo é mexer em `val_real_cpi_usd` e `val_real_hicp_eur` em até 3%, sem defeito visível ali. Se
preferir o menor raio de efeito numa primeira rodada, separar os estrangeiros é uma mudança de ~10
linhas na macro (um segundo valor de variável); a medição acima é o que sustenta qualquer das duas.

## Opção (a): o aviso, em texto proposto (não implementado)

Para as telas com correção em R$ (IPCA, IGP-M, IGP-DI), quando o período inclui anos de 1986 a 1994:

> *Em 1986–1994 a inflação passava de 20% ao mês. O valor anual de cada produto é corrigido pela
> média do índice do ano, e a distribuição do valor ao longo do ano não é conhecida. Os valores
> corrigidos desses anos são indicativos: comparações com 1995 em diante podem estar distorcidas.*

Onde viveria: ao lado da nota de reforma monetária (`MonetaryNotes`), com a mesma regra de aparecer só
quando o intervalo escolhido toca esses anos. É independente de (b): faz sentido mesmo se (b) não for
adotada, e com `year_end` o texto seria "índice de dezembro" e a distorção, bem maior.

## Se a decisão for adotar (b) — passos, não executados

1. `backup-gold` (`make backup-gold` ou `uv run embrapa backup-gold`).
2. Trocar o padrão para `year_avg` em `dbt_project.yml`. **Sem `--full-refresh`**: o Gold é `table`, um
   build comum o reescreve, e o Silver não muda (corrijo aqui o que o brief desta tarefa dizia).
3. Um build de produção disparado à mão; depois `embrapa doctor`, onde o `quality-drift` vai avisar
   (esperado) e o `bq-spend` conta um build a mais.
4. **Renomear** as colunas `*_year_end` da macro (`*_year_index`) quando for definitivo; ficaram com o
   nome antigo só para o protótipo não tocar os quatro consumidores.
5. Atualizar o que diz "índice de dezembro" / "fim do ano": `_gold.yml` (descrições de coluna, o IGP-M
   "NULL antes de 1989" passa a 1990, e o bloco de testes unitários), `ARCHITECTURE.md:358`,
   `docs/frontend_data_contract.md:202`, os docstrings de `serving/sql.py` (`annual_value_gap`),
   `webapi/seam.py` e `webapi/serializers.py`, `tests/test_snapshot_value_gap.py`,
   `tests/test_webapi_seam.py`, `tests/test_foreign_inflation.py`, o comentário de
   `assert_foreign_inflation_no_month_gaps.sql`, `CLAUDE.md` e o glossário do painel; o ABNT/Referências
   se citarem a regra.
6. Registrar no CHANGELOG, como mudança de número publicado, com os fatores desta tabela.

## O que fica por medir

- **Sazonalidade.** A média simples supõe volume real uniforme no ano. Uma colheita concentrada no 2º
  trimestre (soja, café) pede um índice ponderado pelo perfil mensal do produto, e o IBGE só publica o
  valor anual: **não dá para medir** com o dado que existe. É o limite da opção (c).
- **A causa do salto de 1995.** Esta medição não separa preço real de artefato (acima).
- **O ano corrente da COMTRADE.** O total só tem 2000–2025, então o caso "último ano aberto" ficou
  coberto pelo teste unitário, não por dado real.

## Reproduzir

- `dbt build --target dev --select gold_pam_production gold_pevs_production gold_ppm_production
  gold_comtrade_flows serving_pam_annual serving_pevs_annual serving_ppm_annual serving_comtrade_annual
  serving_quality_by_source --defer --favor-state --state <parse --target prod> --vars
  '{enable_curation: true, enable_foreign_inflation: true, inflation_year_basis: year_avg}'`
  (**um** mapa de `--vars`: o dbt guarda só o último).
- Comparação: o mesmo `group by reference_year` em `dbt_dev_serving.serving_*_annual` e em
  `serving.serving_*_annual`; para as flags, junção por `(reference_year, city_code, product_code,
  tabela)` entre `dbt_dev_gold.gold_*_production` e `gold.gold_*_production` — com **igualdade simples**
  no `ON`: `IS NOT DISTINCT FROM` ali impede o hash join e a consulta não termina.
- Razão analítica: `max_by(index_value, reference_month) / avg(index_value)` por ano, em
  `silver.silver_inflation`, para a série `190`.

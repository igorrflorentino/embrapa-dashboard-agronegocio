# Auditoria da lógica de qualidade dos dados — 2026-09-24 (v1.88.8)

> **STATUS — HISTORICAL: todos os dez achados foram corrigidos, em duas versões.** A1, A3,
> A6, A7, A8, A9 e A10 na v1.89.0, no PR que trouxe este relatório, **sem mudar nenhuma tag
> no Gold** (§ Verificação da v1.89.0). A2, A4 e A5 mudam tags, foram aprovados pelo
> mantenedor em 2026-09-24 e entraram na v1.90.0, num PR separado de propósito: o primeiro
> tinha que deixar o Gold idêntico, e só assim isso pode ser verificado; o segundo muda tags
> de propósito, e o diff dele bateu, transição por transição, com o contrafactual medido
> antes de escrever o código (§ Verificação da v1.90.0). Juntos, um mascararia o outro.
> As MEDIÇÕES dos achados são o retrato de 2026-09-24, antes das correções.

Auditoria pedida sobre **a lógica que decide a qualidade de cada linha do acervo**, com dois
objetivos: achar erros, bugs e inconsistências, e explicar como a lógica é construída, quais
tags existem e qual critério decide cada uma.

| superfície | o que faz | onde |
|---|---|---|
| Cascata de tags | decide a `data_quality_flag` de cada linha | `dbt/macros/data_quality_flag.sql` |
| Detector de preço implícito | marca atípico / problemático / não avaliado | `dbt/macros/quality_outlier_ctes.sql` |
| Os 5 Gold | chamam as macros; PAM, PPM e COMEX têm regras próprias | `dbt/models/gold/gold_*` |
| Mart do donut | contagem e fração por tag (`share`, `value_share`) | `dbt/models/serving/serving_quality_by_source.sql` |
| Leitores diretos | série anual e por produto | `serving/sql.py` (`quality_timeseries`, `quality_by_product`) |
| Rótulos e legendas | o que o pesquisador lê | `webapi/serializers.py` (`_FLAG_LABEL_PT`), `frontend/src/ui/data.js` (`QUALITY_FLAGS`), `glossary.js` |

**Veredito: o desenho é bom e o detector funciona.** Testar o preço (valor ÷ quantidade) em
vez do tamanho é o que permite separar um gigante legítimo de um erro de digitação, e a
distinção `OK` × `UNSCORED` (v1.49.0) é a coisa certa. Os achados são, na maior parte,
**pontos onde o texto ou a medida afirmam mais do que o detector fez**, e um deles (A1) é a
regra "ausência não é zero" do próprio projeto, quebrada no número cuja função é dizer
quanto ficou sem exame.

Todo número abaixo foi medido hoje contra o prod (`embrapa-dashboard-commodities`) com
consultas somente-leitura. A reconstrução do detector em SQL (§ Método) bate com o Gold
linha a linha (ex.: PAM `OK` = 843.735 dos dois lados), então os contrafactuais medidos com
ela são confiáveis.

---

## Como a lógica é construída

> Descrição da lógica como ela estava na v1.88.8, quando a auditoria foi feita. Desde a
> v1.90.0: o IBGE escora `val_real_igpdi_brl` (não mais o IPCA); o piso testa
> `greatest(valor, quantidade × preço mediano)` (não mais só o valor); e o COMTRADE emite
> `MISSING_WEIGHT` antes da cascata, para todo valor sem peso. O resto segue como abaixo.

### O detector

Por linha, dentro de um grupo (a janela `_qw`):

- **Grupo.** IBGE `(product_code, tabela, family)` sobre TODOS os anos e municípios; COMEX
  `(flow, ncm_code)` sobre todos os meses, países, UFs e vias; COMTRADE `(flow, cmd_code)`
  sobre todos os anos, reportantes e parceiros.
- **O que se escora.** IBGE: `val_real_ipca_brl` (deflacionado; o nominal fabricaria uma
  cauda falsa na hiperinflação) ÷ `qty_native`. Comércio: US$ nominal ÷ `net_weight_kg`.
- **Guarda** (linha não examinada → `UNSCORED`): valor nulo ou ≤ 0, quantidade nula ou ≤ 0,
  grupo sem mediana, grupo com menos de 100 preços (`quality_min_obs`), ou valor abaixo de
  100.000 (`quality_value_floor`; R$ deflacionado ou US$).
- **PROBLEMÁTICO.** |ln preço − mediana de ln preço| ≥ ln(100): o preço está mais de 100×
  acima ou abaixo da mediana (`quality_price_k`). A culpa vai para a medida mais anômala:
  excesso = (ln x − mediana) ÷ (p75 − mediana); se |exc. valor| ≥ |exc. quantidade| →
  `PROBLEMATIC_VALUE`, senão `PROBLEMATIC_QUANTITY`.
- **ATÍPICO** (só se não for problemático, e só do lado alto): exc. valor ≥ 4
  (`quality_outlier_k`) → `OUTLIER_VALUE`; senão exc. quantidade ≥ 4 → `OUTLIER_QUANTITY`.

### A cascata (a primeira regra que casa vence)

- **PAM:** `AREA_INCONSISTENT` (plantada < colhida) → `INCOMPLETE` (sem quantidade e sem
  valor) → `MISSING_VALUE` → `MISSING_QUANTITY` → `PROBLEMATIC_VALUE` →
  `PROBLEMATIC_QUANTITY` → `OUTLIER_VALUE` → `OUTLIER_QUANTITY` → `UNSCORED` → `OK`.
- **PEVS e PPM-fluxo:** a mesma, sem a primeira regra.
- **PPM-rebanho** (`measure_kind = 'stock'`): `MISSING_QUANTITY` se não houver cabeças,
  senão `UNSCORED` — um estoque não tem valor, logo não tem preço.
- **COMEX** (CASE próprio): `INCOMPLETE` → `MISSING_VALUE` → `MISSING_WEIGHT` → os tiers
  do detector → `UNSCORED` → `OK`.
- **COMTRADE:** a macro padrão, com "tem quantidade" = `coalesce(qty_native,
  net_weight_kg)`; o detector só olha o peso.

### As 13 tags, e quem as emite em produção

| tag | critério | linhas em prod (2026-09-24) |
|---|---|---|
| `OK` | examinada, sem marca | PAM 33,5% · PEVS 18,2% · PPM 12,5% · COMEX 34,2% · COMTRADE 33,7% |
| `UNSCORED` | a guarda bloqueou | PAM 66,3% · PEVS 81,7% · PPM 87,2% · COMEX 65,2% · COMTRADE 64,6% |
| `OUTLIER_VALUE` / `_QUANTITY` | exc. ≥ 4, preço dentro de 100× | os 5 bancos, 0,05–0,34% das linhas e 8–22% do valor |
| `PROBLEMATIC_VALUE` | preço ≥ 100× fora, culpa no valor | PAM 2 · PEVS 14 · COMEX 16 · COMTRADE 1.360 |
| `PROBLEMATIC_QUANTITY` | preço ≥ 100× fora, culpa na quantidade | PAM 2 · PEVS 6 · PPM 1 · COMEX 4 · COMTRADE 1.626 |
| `AREA_INCONSISTENT` | PAM, plantada < colhida | PAM 2 |
| `MISSING_QUANTITY` | valor sem quantidade | só COMTRADE, 25.638 |
| `MISSING_VALUE`, `MISSING_WEIGHT`, `INCOMPLETE` | ausências | **0 em todos os bancos** (ver A4 e A9) |
| `INFERRED_QUANTITY`, `INFERRED_VALUE` | reservadas | nenhum código as emite |

---

## Método

O detector é reconstruído fora do Gold, com a mesma janela e a mesma guarda. Com isso dá
para perguntar "o que aconteceria se…" sem rebuild. Esqueleto (PAM; os outros bancos trocam
a janela e as colunas, como em § O detector):

```sql
WITH s AS (
  SELECT data_quality_flag f, reference_year y, v, q,
    PERCENTILE_CONT(SAFE.LN(SAFE_DIVIDE(v, q)), 0.5) OVER w med_p,
    PERCENTILE_CONT(SAFE.LN(v), 0.5) OVER w med_v, PERCENTILE_CONT(SAFE.LN(v), 0.75) OVER w p75_v,
    PERCENTILE_CONT(SAFE.LN(q), 0.5) OVER w med_q, PERCENTILE_CONT(SAFE.LN(q), 0.75) OVER w p75_q,
    COUNT(SAFE_DIVIDE(v, q)) OVER w n
  FROM (SELECT product_code, tabela, family, reference_year, data_quality_flag,
               val_real_ipca_brl v, qty_native q
        FROM `embrapa-dashboard-commodities.gold.gold_pam_production`)
  WINDOW w AS (PARTITION BY product_code, tabela, family))
SELECT f, COUNT(*) FROM s
WHERE NOT (v IS NULL OR v <= 0 OR q IS NULL OR q <= 0 OR med_p IS NULL OR n < 100 OR v < 100000)
GROUP BY f
-- → OK 843.735 · OUTLIER_VALUE 3.512 · OUTLIER_QUANTITY 1.284 · PROBLEMATIC_* 2 + 2,
--   exatamente as contagens do Gold.
```

Custo total da auditoria: cerca de 5 GB faturados (menos de US$ 0,05).

---

## 🔴 A1 — O `value_share` contava a lacuna do deflator como R$ 0

`serving_quality_by_source.sql` pesava o IBGE por `coalesce(val_real_ipca_brl, 0)`. O IPCA
começa em 1980; a PAM e a PPM começam em 1974. As linhas de 1974–1979 entravam no peso com
valor **zero**, e são justamente as linhas que o detector não consegue examinar, porque ele
escora pelo mesmo IPCA. O número que existe para dizer quanto dinheiro ficou sem exame
apagava exatamente esse dinheiro.

Medido pelo IGP-DI, que cobre 1974 em diante (0 linhas com valor sem IGP-DI nos três bancos
IBGE, contra 355.644 sem IPCA):

| banco | `UNSCORED` por valor (a tela mostrava) | medido pelo IGP-DI |
|---|---|---|
| PAM | 0,10% | **8,98%** |
| PPM | 0,28% | **10,38%** |
| PEVS | 0,70% | 0,74% (começa em 1986; muda só o peso relativo dos anos) |

A frase "o detector examina mais de 99% do dinheiro em todo banco" (cabeçalho do mart,
`sql.py`, `contracts.js`) e "over 96% in every banco" (README) eram falsas para PAM (~91%) e
PPM (~90%).

```sql
SELECT src,
  ROUND(SAFE_DIVIDE(SUM(IF(f = 'UNSCORED', igpdi, 0)), SUM(igpdi)) * 100, 3) pct_unscored_by_igpdi,
  COUNTIF(val IS NOT NULL AND igpdi IS NULL) valued_without_igpdi,
  COUNTIF(val IS NOT NULL AND ipca IS NULL) valued_without_ipca
FROM (SELECT 'pam' src, data_quality_flag f, val_yearfx_brl val, val_real_ipca_brl ipca,
             val_real_igpdi_brl igpdi FROM `embrapa-dashboard-commodities.gold.gold_pam_production`
      UNION ALL SELECT 'ppm', data_quality_flag, val_yearfx_brl, val_real_ipca_brl, val_real_igpdi_brl
             FROM `embrapa-dashboard-commodities.gold.gold_ppm_production`)
GROUP BY src
-- → pam 8,975 / 0 / 213.336 · ppm 10,381 / 0 / 142.308
```

**Corrigido na v1.89.0:** o mart pesa o IBGE por `val_real_igpdi_brl`; o `coalesce(…, 0)`
agora só zera o rebanho, que não tem valor por construção. Guarda:
`test_quality_value_share_weights_ibge_by_a_deflator_that_covers_every_row`.

## 🟠 A2 — O piso de materialidade é cego a um lado do erro

`_q_guard` testa o valor REPORTADO contra o piso. Um erro que ENCOLHE o valor (dígitos
perdidos) empurra a linha para baixo do piso, e ela nunca é examinada. O comentário da macro
dizia que "dropped digits stay flagged", o que só vale para dígitos perdidos na QUANTIDADE.

Linhas abaixo do piso com preço ≤ 1/100 da mediana e **valor esperado** (quantidade × preço
mediano) acima do piso:

| banco | escondidas | marcadas `PROBLEMATIC_*` |
|---|---|---|
| COMTRADE | 1.030 | 2.986 |
| PEVS | **24** | 20 |
| COMEX | 5 | 20 |
| PAM | 2 | 4 |
| PPM | 0 | 1 |

No PEVS, o escondido supera o detectado.

```sql
-- sobre a reconstrução de § Método, com dev = SAFE.LN(SAFE_DIVIDE(v, q)) - med_p:
COUNTIF(v > 0 AND v < 100000 AND q > 0 AND n >= 100
        AND dev <= -LN(100) AND EXP(med_p) * q >= 100000)
```

**Corrigido na v1.90.0:** a guarda testa `greatest(valor, quantidade × exp(mediana de ln
preço))` contra o piso, ou seja, "material por qualquer das duas medidas". Efeito medido:
1.030 `PROBLEMATIC` novos no COMTRADE (756 na quantidade, 274 no valor), 11 no PEVS, 5 no
COMEX, 2 na PAM. **E um efeito maior, que não estava no enunciado do achado:** o piso novo
também examina linhas legítimas — valor pequeno com quantidade material, preço abaixo da
mediana mas dentro de 100× — que ficavam `UNSCORED` e agora são, quase todas, `OK`: PAM
37.636, PEVS 25.179, PPM 17.997, COMEX 13.349, COMTRADE 77.053. O ruído de arredondamento
que o piso existe para barrar não volta com elas: arredondar um valor pequeno move o preço
por uma fração, nunca pelos 100× que PROBLEMÁTICO exige, e os números acima (11 no PEVS,
0 na PPM) mostram isso.

## 🟠 A3 — As legendas descreviam o que o detector não faz

`frontend/src/ui/data.js` e `glossary.js`:

- **`PROBLEMATIC_QUANTITY`** dizia "Quantidade bem acima do esperado". O detector é
  bilateral, e **83% dessas linhas (1.360 de 1.639) têm quantidade ABAIXO da mediana**:
  COMTRADE 1.350/1.626, COMEX 4/4. É o placeholder peso = 1, o caso típico citado no próprio
  comentário da macro. (Já `PROBLEMATIC_VALUE` está, na prática, sempre acima: 0 de 1.392.)
- **`OUTLIER_*`** dizia "preço implícito coerente — considerado válido". Coerente quer dizer
  "dentro de 100×". Atípicos com preço 10× ou mais fora da mediana: COMTRADE **460 de 4.671**
  (61 com 30× ou mais), COMEX 41, PAM 36, PEVS 26, PPM 12.

```sql
COUNTIF(f = 'PROBLEMATIC_QUANTITY' AND SAFE.LN(q) < med_q)      -- quantidade abaixo da mediana
COUNTIF(f LIKE 'OUTLIER%' AND ABS(dev) >= LN(10))               -- atípico com preço ≥ 10× fora
```

**Corrigido na v1.89.0:** as legendas dizem "mais de 100× acima ou abaixo", nomeiam o caso
típico (quantidade abaixo) e dizem que "dentro de 100×" é uma faixa larga. Com o piso da
v1.90.0 (A2), os novos casos do COMTRADE são pesos com dígitos a mais, e a fração abaixo da
mediana caiu para **57% (1.359 de 2.401)**; a legenda passou a dizer "pouco mais da metade".

## 🟡 A4 — Comércio sem peso: a mesma situação ganha três tags

`MISSING_WEIGHT` só está ligada no COMEX, que tem **0 linhas** sem peso. No COMTRADE, as
**79.536 linhas com valor e sem peso** se dividem em `MISSING_QUANTITY` (25.638, sem
quantidade também) e `UNSCORED` (53.898, com quantidade em outra unidade); **33.091 delas
passam de US$ 100 mil**. E o peso "0" vira NULL no Silver do COMTRADE, mas continua 0 no
COMEX (2.633 linhas, todas `UNSCORED`). A legenda de `UNSCORED` listava quatro motivos e
omitia este.

```sql
SELECT data_quality_flag, COUNTIF(net_weight_kg IS NULL) sem_peso,
       COUNTIF(net_weight_kg IS NULL AND val_yearfx_usd >= 100000) sem_peso_material
FROM `embrapa-dashboard-commodities.gold.gold_comtrade_flows` GROUP BY 1
-- → MISSING_QUANTITY 25.638 / 8.932 · UNSCORED 53.898 / 24.159
```

**Corrigido na v1.89.0 (texto)** — a legenda de `UNSCORED` ganhou o motivo que faltava — **e
na v1.90.0 (tags):** o COMTRADE emite `MISSING_WEIGHT` quando há valor e o peso é nulo, antes
da cascata, sob o mesmo gate da taxonomia Q1. As 79.536 linhas saem de `MISSING_QUANTITY`
(25.638) e `UNSCORED` (53.898); 91,8% delas são do capítulo 44 (madeira, quantidade em outras
unidades). `MISSING_QUANTITY` deixa de ocorrer no COMTRADE. O peso "0" do COMEX (2.633 linhas,
`UNSCORED`) ficou como está: não estava no escopo aprovado, e a divergência está anotada no
Silver do COMTRADE.

## 🟡 A5 — O detector do IBGE escora pelo IPCA, que começa em 1980

213.336 linhas da PAM e 142.308 da PPM (1974–1979) são `UNSCORED` por construção. Pelo
IGP-DI, 109.475 + 48.735 delas passariam do piso e seriam examinadas.

**Corrigido na v1.90.0:** as três macros escoram `val_real_igpdi_brl` em todos os anos (um
índice só na janela; misturar IPCA e IGP-DI distorceria a mediana), e
`test_ibge_q1_scores_on_deflated_value_not_nominal` exige o IGP-DI nas quatro chamadas. Efeito
medido nas linhas que deixam de ser `UNSCORED`: 109.837 da PAM e 48.773 da PPM por causa da
lacuna do IPCA, e mais 39.552 / 20.596 / 19.605 (PAM / PPM / PEVS) porque o valor corrigido
pelo IGP-DI é maior que pelo IPCA e cruza o piso de R$ 100 mil. Trocar o índice também move
as medianas, e algumas centenas de linhas por banco trocam entre `OK`, `OUTLIER_VALUE` e
`OUTLIER_QUANTITY` (PAM: 363 atípicos viram `OK` e 205 `OK` viram atípicos, por exemplo).

## 🟡 A6 — As taxas de calibração documentadas não se reproduziam

O `dbt_project.yml` e o cabeçalho da macro traziam as taxas de PROBLEMÁTICO da validação de
2026-06-26. Medido hoje (linhas `PROBLEMATIC_*` ÷ todas as linhas do Gold):

| banco | documentado | medido |
|---|---|---|
| PAM | 0,03% | 0,0002% (4) |
| COMEX | 0,19% | 0,005% (20) |
| COMTRADE | 0,43% | 0,145% (2.986) |
| PEVS | 0,003% | 0,0015% (20) |
| PPM | 0,002% | 0,00003% (1) |

Uma a duas ordens de grandeza de diferença, e aquele comentário era o único registro da
calibração.

**Corrigido na v1.89.0:** os dois comentários trazem os números medidos, a data e a
origem dos números antigos.

### A causa (investigada em 2026-09-24, depois da v1.90.1)

**Não houve regressão no detector.** A macro ficou idêntica de 2026-06-27 (quando a Q1 foi
ligada, `7e4ed87`) a 2026-09-24; a única mudança no meio (`ee8796f`, v1.49.0) acrescentou o
`UNSCORED` sem tocar a regra do PROBLEMÁTICO. A "queda" tem duas causas diferentes.

**1. COMEX, PEVS e COMTRADE: o comentário misturava taxas SEM o piso de materialidade.** A
validação mediu cada banco duas vezes, antes e depois de criar o piso, e o comentário guardou a
medição de antes para esses três. Reproduzido no backup de 2026-07-05:

| banco | comentário | detector **sem** piso (07-05) | **com** piso (07-05) | tabela do PLAN (com piso) |
|---|---|---|---|---|
| COMEX | 0,19% | **0,193%** | 0,0057% | 0,0057% |
| PEVS | 0,003% | **0,003%** | 0,0009% | 0,0009% |
| COMTRADE | 0,43% | 0,91% | 0,151% | 0,15% |

Com o piso, que é como o Gold sempre rodou, os três são estáveis de julho até hoje. O 0,43% do
COMTRADE não se reproduz exatamente: foi medido no meio do backfill mundial (2,29 mi linhas),
entre os dois snapshots que existem (572 mil em 06-13, 2,31 mi em 07-05). As taxas sem piso
desses dois momentos (0,84% e 0,91%) estão na mesma ordem.

**2. PAM e PPM: a queda foi real, e foi o detector funcionando.** No backup de 2026-06-13, com
as mesmas 1.124.058 linhas da PAM, o detector dá **0,0198% (223 linhas)** com piso e **1,75%**
sem piso — os números documentados. Das 223, **219 eram soja de 1985**, e no backup de 07-05 as
mesmas linhas têm valor **exatamente 1.000× maior**, com a mesma quantidade. O IBGE rotula o
valor de 1985 da PAM e da PPM como "Mil Cruzeiros", mas a magnitude é de Cruzados (a reforma de
1986); o seed de moedas seguia o rótulo e deixava o ano 1.000× pequeno. O `80464a3`
(2026-06-27, macro `ibge_1985_cruzado_correction`) corrigiu, e a própria mensagem do commit
registra "*PAM problemático 223 -> 4, PPM 8 -> 1*". O "1,96% sem piso" do comentário do
`_q_guard` era, na prática, o ano de 1985 inteiro (~22 mil linhas); com piso, só a soja, a maior
lavoura, passava dos R$ 100 mil mesmo dividida por mil.

Duas coisas ficaram erradas na documentação: as taxas de antes da correção foram parar nos
comentários e na tabela do PLAN, e o PLAN descreve essas 223 linhas como "*genuine typos*".
Eram um erro de pipeline, o primeiro que o detector encontrou. A assinatura é a mesma de
`docs/divergencias_de_conteudo.md`: um erro sistemático se concentra (um produto, um ano, um
fator exato), enquanto erros de digitação aparecem espalhados.

```sql
-- Os backups do Gold se consultam direto no GCS, sem restaurar nada: uma definição de tabela
-- externa que vale só para a consulta (PowerShell 5.1: SQL numa linha só).
-- bq query --location=us-central1 --nouse_legacy_sql
--   "--external_table_definition=jun::@PARQUET=gs://embrapa-dashboard-commodities-datalake/backups/run=20260613T233002Z/gold_pam_production/*.parquet"
--   "--external_table_definition=jul::@PARQUET=gs://embrapa-dashboard-commodities-datalake/backups/run=20260705T121705Z/gold_pam_production/*.parquet"
WITH s AS (
  SELECT reference_year y, city_code c, product_code p, product_description d,
         val_yearfx_brl vn, val_real_ipca_brl v, qty_native q,
         PERCENTILE_CONT(SAFE.LN(SAFE_DIVIDE(val_real_ipca_brl, qty_native)), 0.5)
           OVER (PARTITION BY product_code, family) med_p
  FROM jun),
f AS (SELECT * FROM s WHERE v > 0 AND q > 0 AND v >= 100000
                        AND ABS(SAFE.LN(SAFE_DIVIDE(v, q)) - med_p) >= LN(100))
SELECT f.y, COUNT(*) n, ANY_VALUE(f.d) produto,
       AVG(SAFE_DIVIDE(j.val_yearfx_brl, f.vn)) ratio_valor_jul_jun,
       AVG(SAFE_DIVIDE(j.qty_native, f.q)) ratio_qtd_jul_jun
FROM f LEFT JOIN jul j ON j.reference_year = f.y AND j.city_code = f.c AND j.product_code = f.p
GROUP BY f.y ORDER BY n DESC
-- → 1985 · 219 · Soja (em grão) · 1000.0 · 1.0   (e 4 linhas esparsas de outros anos)
```

## 🟡 A7 — ATÍPICO é relativo à história inteira do produto

A janela junta 50 anos, então a tag acompanha a tendência secular do produto. Taxa de
atípicos entre as linhas examinadas:

| banco | desde 2010 | antes de 2010 |
|---|---|---|
| PAM | 0,92% | 0,37% (2,5× menos) |
| PPM | 3,16% | 2,09% |
| PEVS | 0,32% | 0,87% (o inverso: a extração encolheu) |

Quem plota ATÍPICO no tempo vê a tendência da produção, não anomalias.

**Corrigido na v1.89.0 (texto):** as legendas dizem que a comparação é com toda a história
do produto. Mudar a janela (por década, por exemplo) seria outra decisão; não foi pedida.

## 🟢 A8 — Latente: um NULL podia silenciar o PROBLEMÁTICO

`_q_*_excess` é NULL quando o p75 de uma medida é igual à mediana (`nullif` do denominador
zero). A atribuição `abs(NULL) >= abs(x)` é NULL e falha as DUAS condições: uma linha com
preço 1.000× fora caía em `OK`. E `_q_n` contava linhas de valor 0, que a mediana ignora,
então um produto podia passar da amostra mínima com preços que a mediana nunca viu.

Medido: **0 linhas** afetadas por qualquer dos dois, em qualquer banco. Correto por dado,
não por construção — a mesma lição da v1.46.5.

**Corrigido na v1.89.0:** as duas condições de atribuição leem o mesmo predicado com
`coalesce` (`_q_blame_value`), uma direta e outra negada, então são complementares por
construção; `_q_n` conta `safe.ln(safe_divide(…))`. Guardas:
`test_problematic_attribution_is_null_safe_and_exhaustive`,
`test_sample_gate_counts_the_population_the_median_sees`.

## 🟢 A9 — As tags de ausência estão mortas no IBGE por construção

No SIDRA, a ausência é sempre da célula inteira: o `...` aparece em todas as variáveis ao
mesmo tempo (604.241 células na PAM, 388.388 no PEVS-289; nenhum `X` de sigilo). O `HAVING`
do Gold exige quantidade OU valor e descarta a célula antes de a flag ser calculada. Por
isso `MISSING_VALUE`, `MISSING_QUANTITY` e `INCOMPLETE` nunca aparecem no IBGE.

É defensável, porque as células descartadas têm padrões que não são defeito de linha:

- **PAM:** o `...` cai de 42% das células em 1975–79 para ~1% em 2015+. Duas causas,
  sobrepostas: o **município-ano inteiramente nulo** (88,6 mil células em 1975–79, ~3,2 mil
  em 2015+: o município que ainda não existia) e o **produto-ano inteiramente nulo** (um
  produto fora da pesquisa naquele ano; ~27,8 mil células por quinquênio de 1990 a 2014, e
  nenhuma depois).
- **PEVS:** **100%** dos `...` são de município-ano inteiro: o município não tem nenhum dado
  de extração naquele ano. Nenhum produto-ano é inteiramente nulo. O total cresce de ~1.200
  municípios por ano (1985–89) para ~1.960 (2020+); a causa não foi investigada. (Uma
  primeira leitura deste relatório atribuiu o crescimento a "produto que saiu da pesquisa";
  a medição a refutou.)

Mas a legenda de `MISSING_VALUE` ("veio em branco na fonte") não descrevia nenhum caso real
do IBGE.

```sql
-- nulos em município-ano e produto-ano inteiramente nulos (PAM; PEVS: variable_code '145')
WITH c AS (SELECT DIV(reference_year, 5) * 5 y5, reference_year, city_code,
                  COUNTIF(numeric_value IS NULL) n_null, COUNT(*) n
           FROM `embrapa-dashboard-commodities.silver.silver_ibge_pam`
           WHERE variable_code = '215' GROUP BY 1, 2, 3)
SELECT y5, SUM(n_null) n_null, SUM(IF(n_null = n, n_null, 0)) null_in_fully_null_city_years
FROM c GROUP BY y5 ORDER BY y5
-- trocar city_code por product_code dá o recorte por produto-ano
```

**Corrigido na v1.89.0 (texto):** a legenda de `MISSING_VALUE`, o README e o CLAUDE.md
dizem o que acontece no IBGE.

## 🟢 A10 — Consistência e comentários velhos

- `gold_ppm_production` levantava `tabela` com `any_value()`, em vez de agrupar por ela como
  PEVS e PAM. Exato só porque nenhum `(ano, município, código)` aparece nas duas tabelas
  (0 casos, medido). A janela do detector na PAM não tinha `tabela` (inofensivo: banco de
  uma tabela só).
- Comentários velhos: `data.js` ("off by default"), `serializers.py` (taxonomia de 4
  valores), `ViewOverview.test.jsx` ("9 Gold flags"), e o glossário dizia que o IGP-DI começa
  em 1980 (neste acervo ele alcança 1974 desde a v1.81.0).

**Corrigido na v1.89.0.** Guardas: `test_ppm_groups_by_tabela_instead_of_lifting_it`,
`test_ibge_detector_window_is_the_produto_identity`.

---

## Verificação da v1.89.0

A v1.89.0 não pode mudar nenhuma tag. Os seis modelos tocados foram construídos em dev
(`dbt build --target dev --select gold_pam_production gold_ppm_production gold_pevs_production
gold_comex_flows gold_comtrade_flows serving_quality_by_source --defer --favor-state --state
<manifesto de prod>`), lendo o MESMO Silver do Gold de prod (o Silver de prod foi gravado
antes do Gold, no mesmo build de hoje). Resultado: 112 PASS, 2 WARN (os mesmos de prod), 0
ERROR.

| Gold | linhas prod = dev | impressão digital de `(chave, data_quality_flag)` |
|---|---|---|
| PAM | 2.516.602 | idêntica |
| PEVS | 1.351.477 | idêntica |
| PPM | 3.538.360 | idêntica (inclui `tabela`, `measure_kind`, `qty_native`) |
| COMEX | 391.914 | idêntica |
| COMTRADE | 2.055.350 | idêntica |

No mart, `n_rows` e `share` são iguais nos 31 pares `(banco, tag)`; o `value_share` do
COMEX e do COMTRADE também; só o do IBGE muda, para os valores de A1 (PAM `UNSCORED`
0,101% → 8,975%, PPM 0,278% → 10,381%, PEVS 0,700% → 0,735%).

Os testes novos foram rodados contra o `dbt/` da v1.88.8 e **falham lá** (5 de 7; os outros
2 são as janelas do PEVS e do PPM, que já tinham `tabela`), então guardam o que dizem
guardar.

## Verificação da v1.90.0

A v1.90.0 muda tags de propósito, então a prova é outra: **antes** de escrever o código, a
reconstrução de § Método foi rodada com as três mudanças (IGP-DI, piso pelo valor esperado,
`MISSING_WEIGHT` no COMTRADE) sobre o Gold de prod, dando uma matriz "tag antiga → tag nova"
por banco. Depois, o build de dev dos mesmos seis modelos (mesmo `--defer --favor-state` sobre
o Silver de prod) foi comparado com o prod linha a linha, juntando pela chave de cada Gold.

**As 37 transições bateram uma a uma com a matriz prevista**, e nenhuma linha ficou sem par
(nenhuma criada, nenhuma perdida). Build: 112 PASS, 2 WARN (os de sempre), 0 ERROR. As
maiores transições:

| banco | `UNSCORED` → `OK` | outras |
|---|---|---|
| PAM | 186.667 | 612 `OK` → `UNSCORED`; ~1.300 entre `OK` e atípicos; 2 → `PROBLEMATIC_VALUE` |
| PEVS | 44.773 | 365 `OK` → `UNSCORED`; 11 → `PROBLEMATIC_*`; 1 `PROBLEMATIC_VALUE` → `OK` |
| PPM | 86.558 | 346 `OK` → `UNSCORED`; ~2.400 entre `OK` e atípicos |
| COMEX | 12.854 | 490 → atípicos; 5 → `PROBLEMATIC_*` |
| COMTRADE | 76.023 | 79.536 → `MISSING_WEIGHT`; 1.030 → `PROBLEMATIC_*` |

O donut depois da v1.90.0 (mart de dev, 2026-09-24):

| banco | `UNSCORED` linhas / valor | valor examinado | `PROBLEMATIC_*` no Gold |
|---|---|---|---|
| PAM | 58,9% / 0,06% | 99,9% | 6 |
| PPM | 84,7% / 0,16% | 99,8% | 1 |
| PEVS | 78,4% / 0,43% | 99,6% | 30 |
| COMEX | 61,8% / 0,39% | 99,6% | 25 |
| COMTRADE | 58,3% / 0,19% (+ `MISSING_WEIGHT` 3,83%) | 96,0% | 4.016 |

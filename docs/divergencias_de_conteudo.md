# Divergências de conteúdo — o código está certo, o que veio dentro dele não

**Mantido à mão.** É a contraparte de
[`nomenclatura_divergencias.md`](nomenclatura_divergencias.md), e a diferença entre os dois
é o que decide onde uma coisa entra:

| | `nomenclatura_divergencias.md` | este arquivo |
|---|---|---|
| divergência de | **nome** — nosso texto contra o campo de exibição do MDIC | **conteúdo** — o que a fonte lançou dentro do código |
| origem | gerado por `scripts/audit_nomenclature_seeds.py` | achado empírico, medido contra a Gold |
| conserto | trocar o texto do seed | nenhum do nosso lado — a fonte é que classificou assim |

Uma divergência de conteúdo **não tem conserto no pipeline**. O valor e a quantidade estão
corretos; o que está errado é o código sob o qual a fonte os declarou. O que se pode fazer é
(a) registrar aqui, (b) separar o agrupamento para que o preço implícito de cada lado volte a
significar algo, e (c) não fingir que o código isolado é confiável.

**Como estas coisas aparecem.** Por dois caminhos, e o segundo existe porque o primeiro é cego
a uma forma de erro.

- **Pelo preço.** O detector de preço implícito (`data_quality_flag`) marca as linhas, e alguém
  lê a saída. Um código cujo preço implícito se afasta da mediana por ordens de grandeza, de
  forma SISTEMÁTICA e não esparsa, é o sintoma — erro de digitação é esparso; classificação
  errada é concentrada. A consulta que encontra um caso novo está em
  `PLANS/quality_outliers_and_visibility_gate.md`. Foi assim com o `1005 10`.
- **Pelo tempo.** Quando o produto foi lançado na tabela errada mas com preço de mercado, o
  detector não vê nada: o preço está certo. O sintoma passa a ser a série — um valor grande
  num ano só, cercado de anos sem registro. Foi assim com Ortigueira e Telêmaco Borba, achados
  ao investigar os municípios sem extração do PEVS (`docs/audits/qualidade_dados_audit_2026-09-24.md`
  § A9). Desde a v1.92.0 esse padrão tem detector: a tag `ISOLATED_SPIKE`
  (`macros/isolated_spike.sql`) marca o registro isolado que faz a série do estado saltar.

---

## `1005 10` — milho para semeadura recebendo milho comum

**Medido em produção 2026-09-09**, repartindo o código pelo preço implícito (o corte em
1,00 US$/kg é generoso: a mediana do próprio código é 2,94 e o milho commodity roda perto
de 0,20):

| banco | faixa | linhas | peso | valor | preço médio |
|---|---|---|---|---|---|
| **COMTRADE** (`100510`) | preço de commodity | 8.794 | **88,88 mi t** | US$ 23,06 bi | 0,259 |
| | preço de semente | 43.545 | 29,71 mi t | US$ 97,00 bi | 3,265 |
| **COMEX** (`10051000`) | preço de commodity | 394 | 64,3 mil t | US$ 26,0 mi | 0,404 |
| | preço de semente | 4.534 | 530,5 mil t | US$ 1,72 bi | 3,246 |

No **COMTRADE, 75% do peso** declarado como semente está a preço de commodity. Ninguém
embarca 1,7 bilhão de kg de semente (foi o caso de 2011, reportante 364 → parceiro 757).
Quem calcular o preço implícito do código no mundo obtém **US$ 1,01/kg** quando a semente
de verdade é **3,27** — errado por 3,2×.

No **COMEX** a contaminação é de **10,8% do peso e 1,5% do valor**. O MDIC classifica bem;
o agregado de ~200 reportantes, não. Essa assimetria é o achado mais útil daqui: para este
código, o dado brasileiro é confiável e o mundial não é.

### O que foi feito

O agrupamento `milho` somava os dois códigos, e os dois mercados têm preços que diferem
**16×** — a média ponderada não descrevia nenhum. Separado em 2026-09-09:

| agrupamento | id | códigos |
|---|---|---|
| **Milho em grão** | `milho` | `10059010` (comex), `100590` (comtrade) + os do IBGE |
| **Semente de milho** | `semente_de_milho` | `10051000` (comex), `100510` (comtrade) |

O agrupamento `milho` foi **renomeado** de "Milho" para "Milho em grão" de propósito: ele
perdeu ~530 mil t (COMEX) e 29,7 mi t (COMTRADE) de volume, e uma série que muda de conteúdo
sem mudar de nome é o defeito que este projeto persegue em toda parte.

### O que a separação NÃO conserta

**"Semente de milho" continua contendo, no COMTRADE, 75% de milho comum.** A separação
arruma o agrupamento; não arruma o dado do reportante. Ao analisar esse agrupamento:

- o lado **COMEX** é confiável (10,8% de contaminação);
- o lado **COMTRADE** não é — trate o volume como teto e o preço como piso;
- **não** compare os dois lados como se medissem a mesma coisa.

---

## `289 · 3435` — madeira de floresta plantada, provavelmente, na tabela da extração nativa (Ortigueira e Telêmaco Borba, PR, 2011)

**Medido em 2026-09-24**, e conferido na API do SIDRA: o IBGE publica exatamente estes
números, então a divergência é da fonte, não do nosso pipeline.

Dois municípios **vizinhos** dos Campos Gerais, polo de floresta plantada, registram madeira em
tora na tabela da **extração nativa** (SIDRA 289) em **um único ano**:

| município | 2010 (t289) | **2011 (t289)** | 2012 (t289) | silvicultura (t291), 2009–2015 |
|---|---|---|---|---|
| Ortigueira | `...` | **200.000 m³ · R$ 20,00 mi** | `...` | R$ 34–89 mi/ano, contínua |
| Telêmaco Borba | `...` | **123.500 m³ · R$ 12,35 mi** | `...` | R$ 165–338 mi/ano, contínua |

**Por que "provavelmente" e por que classificação, e não digitação.** Não temos o questionário
do IBGE, e uma supressão legal de mata nativa num ano só explicaria um dos municípios. Não
explica a assinatura dos dois juntos:

- o mesmo ano e o mesmo produto em municípios vizinhos;
- valores redondos e o **mesmo preço exato, R$ 100/m³**;
- nada antes e nada depois na extração nativa, enquanto a silvicultura dos dois soma centenas
  de milhões todo ano.

É concentrado, não esparso — o padrão de classificação errada descrito acima. São também, de
longe, os maiores "anos isolados" do PEVS desde 1995 (valor 196× e 121× o do produtor mediano
do ano; o terceiro maior caso é 27×).

**O impacto.** Os dois registros são **46,8% da madeira em tora nativa do Paraná em 2011**
(323.500 de 690.863 m³). A série estadual vai de 351 mil m³ (2010) para 691 mil (2011) e volta
a 313 mil (2012); sem eles, 2011 fica em 367 mil e acompanha a queda. No Brasil, pesam 2,3%
(14,1 mi m³).

**Por que o detector de qualidade não marcou.** As duas linhas saíam `OK`: R$ 100/m³ é um preço
plausível para madeira, e o detector julga o preço, não a série no tempo. Desde a v1.92.0 as
duas são `ISOLATED_SPIKE`, a tag criada a partir deste caso.

### O que fazer ao analisar

- Na série de madeira em tora **nativa do Paraná**, trate 2011 como inflado por estes dois
  registros: exclua-os ou declare o salto. Na série nacional o efeito é pequeno.
- Some a extração nativa (t289) e a silvicultura (t291) desses municípios com cuidado: se a
  hipótese estiver certa, a mesma madeira pode ter entrado nas duas tabelas em 2011.
- Nenhum conserto no pipeline (regra do projeto: marcar a anomalia, nunca substituir o dado).

```sql
-- os "anos isolados" do PEVS: valor num ano, `...` no anterior e no seguinte
WITH c AS (SELECT reference_year y, city_code, ANY_VALUE(city_name) city,
                  COUNTIF(numeric_value IS NULL) = COUNT(*) all_null, SUM(numeric_value) v
           FROM `embrapa-dashboard-commodities.silver.silver_ibge_pevs`
           WHERE variable_code = '145' AND reference_year >= 1995 GROUP BY 1, 2),
t AS (SELECT c.*, LAG(all_null) OVER w prev_null, LEAD(all_null) OVER w next_null
      FROM c WINDOW w AS (PARTITION BY city_code ORDER BY y)),
med AS (SELECT y, APPROX_QUANTILES(v, 100)[OFFSET(50)] med_y FROM c
        WHERE NOT all_null AND v > 0 GROUP BY y)
SELECT t.y, t.city, t.v, ROUND(t.v / m.med_y) x_mediana
FROM t JOIN med m USING (y)
WHERE NOT all_null AND prev_null AND next_null AND t.v >= 10 * m.med_y
ORDER BY x_mediana DESC
-- → 9 casos desde 1995; Ortigueira 2011 (196×) e Telêmaco Borba 2011 (121×) à frente
```

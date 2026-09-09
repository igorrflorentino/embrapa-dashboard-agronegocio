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

**Como estas coisas aparecem.** Nenhuma foi procurada: o detector de preço implícito
(`data_quality_flag`) marcou as linhas, e alguém leu a saída. Um código cujo preço implícito
se afasta da mediana por ordens de grandeza, de forma SISTEMÁTICA e não esparsa, é o
sintoma — erro de digitação é esparso; classificação errada é concentrada. A consulta que
encontra um caso novo está em `PLANS/quality_outliers_and_visibility_gate.md`.

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

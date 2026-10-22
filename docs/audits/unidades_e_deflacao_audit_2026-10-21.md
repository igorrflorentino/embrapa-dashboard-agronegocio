# Auditoria de unidades e de deflação — 2026-10-21 (v1.100.x)

> **STATUS — FECHADO nos itens A, B e C; ABERTO só no D.** O item A (frutas contadas) **nunca teve
> número errado publicado** (nenhuma das frutas em risco está no catálogo) e foi fechado na
> **v1.102.0**: a seed carrega as 17 frutas da nota do IBGE, com teste da lista e guarda do asterisco.
> O item B (bancos ingeridos) está limpo. O item C (deflação por índice de dezembro) era um defeito
> **vivo** e foi corrigido na **v1.103.0**: o valor anual passou a ser corrigido pela média dos doze
> índices do ano, em produção desde 2026-10-22 (medição e raciocínio em
> `deflacao_indice_medio_2026-10-21.md`). Fica o D: candidatos do PEVS fora do catálogo, para olhar
> antes de cadastrar.

Pergunta que abriu a auditoria, feita ao fim da v1.100.0: *existe outra parte do código com o mesmo
problema nos dados — um rótulo de unidade que não é a unidade — ou com um problema análogo?*

## Método

Tudo medido em produção em 2026-10-21, só leitura, com limite de bytes cobrados em cada consulta:

1. **Universo inteiro do SIDRA, não só o catálogo.** Série nacional de **todo** produto de PAM (t5457,
   85 séries), PEVS (t289, 63; t291, 29) e PPM (t74, 6; t3939, 10), pela API do SIDRA. Critério de
   ruptura de unidade: **mudança de nível persistente** (mediana dos 3 anos seguintes ÷ mediana dos 3
   anteriores, ≥ 3×), porque uma safra ruim reverte e uma troca de unidade não.
2. **Os marts de produção** (`serving_{pam,pevs,ppm}_annual`, de 2 a 4 MB cada) para as 38 séries do
   catálogo: salto de quantidade × comportamento do valor corrigido (IGP-DI).
3. **Rótulos de unidade de comércio** (`unit_native`, `family`) em `gold_comex_flows` e
   `gold_comtrade_flows`; conversões de base do PPM contra o declarado.
4. **O texto do próprio IBGE** (nota `AlteracoesUnidadesMedidaFrutas.pdf`, ligada na seed
   `pam_fruit_unit_eras`) contra os dados.

## Resultado em uma tabela

| onde | o que se mediu | resultado |
|---|---|---|
| PAM, 14 lavouras do catálogo | rompimento de unidade | **limpo** desde a v1.99.0/v1.100.0 (banana, laranja, limão, tangerina convertidas; abacaxi e coco, contados) |
| **PAM, 13 frutas fora do catálogo** | mesmo defeito | **presente em todas** (A abaixo); detector de 4× cego para 5 |
| PEVS t289/t291, 10 séries do catálogo | nível persistente | **limpo** (há quebra em produtos extrativos menores FORA do catálogo: D) |
| PPM t74/t3939, 14 séries do catálogo | nível persistente; fatores de base | **limpo**; leite ×1 (mil L→m³), ovos ×12.000, kg→t ×0,001 corretos |
| COMEX | unidade estatística por NCM ao longo dos anos | **limpo**: nenhuma NCM muda de unidade; 3 unidades (kg líquido, m³, t líquida), todas mapeadas |
| COMTRADE | unidade por código | varia **por país declarante, por natureza**; 4,2% das linhas sem unidade ("Sem unidade (N/A)"), tratadas pelo peso líquido |
| **Valor corrigido pela inflação, todos os bancos IBGE** | continuidade em 1993→1994 | **DEFEITO** (C abaixo) |

## A — Frutas contadas até 2000: o mesmo defeito, em frutas que o painel não mostra

A nota do IBGE nomeia **17 frutas** pesquisadas em mil frutos (mil cachos, na banana) até 2000 e em
toneladas a partir de 2001, sem conversão retroativa na tabela. A v1.99.0 converteu as 4 do catálogo.
Medido em 2026-10-21, a razão nacional 2001/2000 confere com o peso por fruto que o IBGE publica:

| fruta | peso IBGE (kg/fruto) | quantidade 2001÷2000 | rendimento 2001÷2000 | a banda de 4× pega? | situação |
|---|---:|---:|---:|:-:|---|
| banana (cacho) | 10,20 | 10,91 | 11,22 | sim | convertida (v1.99.0) |
| laranja | 0,16 | 0,159 | 0,165 | sim | convertida (v1.99.0) |
| limão | 0,10 | 0,117 | 0,119 | sim | convertida (v1.99.0) |
| tangerina | 0,15 | 0,187 | 0,182 | sim | convertida (v1.99.0) |
| caqui | 0,18 | 0,207 | 0,187 | sim | fora do catálogo |
| figo | 0,09 | 0,075 | 0,073 | sim | fora |
| goiaba | 0,16 | 0,143 | 0,142 | sim | fora |
| maçã | 0,15 | 0,124 | 0,121 | sim | fora |
| maracujá | 0,15 | 0,169 | 0,171 | sim | fora |
| pêra | 0,17 | 0,190 | — | sim | fora |
| pêssego | 0,13 | 0,122 | 0,116 | sim | fora |
| melancia | 6,08 | 6,40 | 6,65 | sim | fora |
| **abacate** | 0,38 | 0,448 | 0,480 | **não** | fora |
| **manga** | 0,31 | 0,363 | 0,365 | **não** | fora |
| **marmelo** | 0,19 | 0,252 | 0,232 | **não** (3,97×) | fora |
| **melão** | 1,39 | 1,514 | 1,215 | **não** | fora |
| **mamão** | 0,80 | 0,879 | 1,001 | **não** (o rendimento nem se mexe) | fora |

Duas conclusões:

1. **Nenhum número publicado está errado hoje**: nenhuma das 13 frutas está no catálogo, e a
   ingestão em produção é guiada pelo catálogo.
2. **A guarda por limiar tem um ponto cego.** `assert_pam_quantity_no_unit_cliff` (≥ 4×) foi
   calibrada nas 4 frutas que se conhecia e não enxerga 5 das 17. A premissa "4× separa as duas
   populações" valia para 14 produtos e deixa de valer para a lista do IBGE. Uma fruta nova com
   esse defeito entraria **sem aviso nenhum**.

Dois sinais legíveis por máquina que o SIDRA já dá, e que nenhuma guarda usa:

- **O asterisco no nome.** Entre os produtos da t5457 (86 em 2020), exatamente dois levam `*` — `Abacaxi*` e
  `Coco-da-baía*` — e são exatamente os dois que a nota do IBGE diz que "continuam a ser pesquisados
  por unidade". O rótulo de unidade diz "Toneladas" nos dois. O asterisco é aviso de unidade.
- **A lista do IBGE.** É finita (17 + as duas contadas) e oficial. Uva "sempre foi pesquisada em peso".

**Feito na v1.102.0** (proposto aqui, executado na rodada seguinte): `pam_fruit_unit_eras` carrega as
13 frutas restantes com os pesos da nota (inertes enquanto o produto não é ingerido, porque o Silver
junta por produto × ano); `tests/test_pam_counted_fruits.py` fixa os códigos, os pesos e os anos das
17; e `assert_pam_asterisked_products_are_counts` (erro) derruba o build se um produto com `*` no
nome for ingerido sem linha em `pam_count_unit_products`. O teste que dizia "uma era sem produto
configurado é dado morto" passou a admitir as frutas da lista, e a página Referências diz quais
estão no painel. Prova: o Silver de dev com a seed de 17 linhas é **idêntico** ao de produção
(20.250.265 linhas, mesmo fingerprint, 1.201.770 linhas estimadas nos dois).

## B — Bancos ingeridos: limpos

- **PEVS (t289, t291) e PPM (t74, t3939)**: nenhuma das 24 séries do catálogo (10 de PEVS, 14 de
  PPM) tem mudança de nível persistente ≥ 3×; somando as 14 da PAM, são as 38 séries varridas nos
  marts. Os 5 saltos anuais ≥ 3× entre elas são movimentos que acompanham o valor, não troca de
  unidade (café 1975→76 ×0,30, a geada; carvão vegetal de silvicultura 1987→88 ×0,33 com o valor
  em ×0,20; pinheiro-brasileiro, espécie sob restrição, três saltos em 20 anos). **Ressalva:**
  "acompanha o valor" afasta troca de unidade, mas não prova que o salto seja real — não foi
  investigada a causa do carvão vegetal de 1987→88.
- **PPM**: `Mil litros`→m³ ×1, `Mil dúzias`→unidade ×12.000, `Quilogramas`→t ×0,001. As ordens de
  grandeza são as esperadas (leite 35,2 bi L; ovos de galinha 4,98 bi dúzias = 59,8 bi unidades).
  Os rebanhos são estoque (`measure_kind = stock`), fora do detector de preço por desenho.
- **COMEX**: a unidade estatística de cada NCM é a mesma em todos os anos (a consulta que procura
  NCM com mais de uma unidade volta vazia). Duas unidades de massa (kg líquido em 58 NCM, t líquida
  em 8) convertem para a mesma base, e as 55 NCM em m³ ficam na família volume.
- **COMTRADE**: cada país declarante usa a própria unidade, então um código tem até quatro
  (kg, m³, itens, nenhuma). 4,2% das linhas não têm unidade e caem em `family = 'desconhecida'`;
  o painel usa o **peso líquido** nessas telas, não a quantidade. É o mesmo universo do
  `MISSING_WEIGHT`, já documentado.

## C — Defeito análogo, mecanismo outro: a deflação por índice de **fim de ano**

Achado pela mesma varredura, procurando o sintoma dual (**preço** que salta com a quantidade
contínua). Em **todos** os produtos de PAM, PEVS e PPM o preço por unidade corrigido pela inflação
salta entre 1993 e 1994 (a única outra ocorrência é o abacaxi em 1986→87, ×0,31, o ano seguinte ao
Plano Cruzado, quando a razão dezembro÷média vai de 1,15 para 1,82):

| mediana entre produtos do preço corrigido (IGP-DI) | 1993÷1992 | **1994÷1993** | 1995÷1994 |
|---|---:|---:|---:|
| PAM | 0,69 | **3,77** | 0,91 |
| PEVS | 1,13 | **2,27** | 0,98 |
| PPM | 0,99 | **2,14** | 1,00 |

Onze séries (9 de PAM, 2 de PEVS) passam de 3× nesse ano (soja ×4,14, café ×4,10, banana ×4,40,
limão ×5,86, tangerina ×5,48, açaí ×5,11…), com a quantidade parada (entre ×0,9 e ×1,2).

**Causa, medida.** `annual_deflation_ctes` deflaciona o valor do ano pelo índice de **dezembro**
(`inflation_year_end`: `order by reference_month desc`). Um valor anual é um **fluxo** acumulado ao
longo do ano; em baixa inflação dezembro e a média do ano quase coincidem, e na hiperinflação não:

| ano | 1986 | 1987 | 1988 | 1989 | 1990 | 1991 | 1992 | **1993** | 1994 | 1995 | 1996 | 1998 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| IGP-DI, dezembro ÷ média do ano | 1,15 | 1,82 | 2,64 | **3,49** | 1,94 | 2,19 | 2,52 | **3,21** | 1,46 | 1,05 | 1,03 | 1,01 |

Ou seja, o valor de 1993 é **subestimado em 3,2×** e o de 1989 em 3,5×. De 1995 em diante a razão fica,
na maior parte dos anos, entre 0,99 e 1,05; **os picos são 1,17 em 2002 e 1,13 em 2020**, anos de forte
desvalorização (a tabela acima para em 1998; uma versão anterior deste texto dizia "no máximo 1,08",
o que só valia até 1999 — corrigido em 2026-10-21 com a série inteira). É por isso que a soja, em R$ de hoje por tonelada, aparece assim:

| ano | 1991 | 1992 | 1993 | **1994** | 1995 | 1996 |
|---|---:|---:|---:|---:|---:|---:|
| como entregue (índice de dezembro) | 713 | 636 | **420** | **1.737** | 1.354 | 1.872 |
| com o índice médio do ano | 1.559 | 1.603 | 1.348 | 2.533 | 1.419 | 1.931 |

O salto 1993→1994 cai de ×4,14 para ×1,88: o índice de dezembro explica **mais da metade** do
degrau. O resto não é defeito de índice: o valor de safra se concentra no 2º trimestre, justamente
onde a inflação de 1994 foi extrema (antes do Plano Real, em 1º de julho), e a média simples do ano
não pondera isso.

**O que NÃO é afetado** (medido): o detector de qualidade. Ele pontua o preço corrigido, mas a
parcela de `OUTLIER_*` fica plana de 1984 a 1999 (PAM 0,81–1,22% das linhas pontuadas; PEVS
0,42–2,30%), e `PROBLEMATIC_*` é ≈ 0 — o erro é o mesmo para todos os produtos de um ano, e a
comparação é de cada preço com a mediana do próprio produto. Também não é afetado o padrão da
tela, **Nominal** (v1.88.0), onde `valueEraBreaks` recusa a comparação entre reformas; mas
`valueEraBreaks` é **vazio de propósito** nas convenções corrigidas, justamente porque se supunha a
série corrigida contínua. Esta medição mostra que não é, antes de 1995.

**Quem enxerga o defeito:** quem escolhe IPCA, IGP-M ou IGP-DI (R$) e compara um ano antes de 1995
com um depois, ou lê a série corrigida de 1986–1994 como trajetória real. As colunas em US$/€
corrigidas pelo CPI/HICP não têm o problema (o câmbio é a média do ano, e a inflação americana e a
da zona do euro são baixas), e o COMEX/COMTRADE começam em 1997 e 2000.

**Opções, para decisão do pesquisador:**

| | o que faz | custo | efeito |
|---|---|---|---|
| a. só avisar | nota nas telas corrigidas e recusa de variação entre 2 pontos quando o intervalo tem ano com razão dezembro÷média > 1,15 | sem reconstruir o Gold | o número continua errado, mas deixa de ser comparado em silêncio |
| **b. índice médio do ano** | `inflation_year_end` → média dos 12 índices mensais do ano (os atuais, `inflation_latest`, ficam) | `backup-gold` antes e um build comum (o Gold é `table`: **não** precisa de `--full-refresh`, e o Silver não muda); muda todo `val_real_*` de IBGE antes de 1995 (×1,15 a ×3,5) e em até 17% de 1995 em diante (IGP-DI: 1,17 em 2002, 1,13 em 2020) | remove a parte dominante do degrau (soja ×4,1 → ×1,9) |
| c. ponderar pela safra do produto | índice médio ponderado pelo perfil mensal de cada produto | inviável: o IBGE publica só o valor anual | — |

Recomendação: **b**, mais **a** para o resíduo de 1994. Os índices estrangeiros (CPI, HICP) usam a
mesma regra de dezembro; a diferença para a média não foi medida aqui, mas com inflação baixa é de
poucos por cento, e eles podem ficar como estão numa primeira rodada.

## D — Candidatos de PEVS fora do catálogo, para olhar antes de cadastrar

Não são defeitos publicados (não estão no catálogo); são o que a varredura do universo achou. A
varredura sinalizou 25 séries de PAM, 27 de PEVS t289 e 2 de t291 com mudança de nível ≥ 3×. Em PAM,
13 são frutas do rompimento de 2001 (A; o marmelo aparece em 1995 porque a varredura registra só a
primeira mudança de cada produto). As outras 12 caem em anos diferentes e espalhados (1977 a 1998),
que é o padrão de lavoura pequena em expansão ou declínio e **não** o de uma troca administrativa de
unidade (essa cai no MESMO ano em vários produtos) — conclusão por esse critério, não verificada
produto a produto. O que sobra de relevante:

- **PEVS 1987→1990: degraus simultâneos em vários produtos extrativos menores.** Palmito 202,4 mil t
  → 27,0 mil t em 1989→90 (×0,13, e fica em ~21 mil t depois), oiticica ×0,16 e caucho ×0,21 no mesmo
  ano, ipeca ×0,12 e "outros" do grupo 8.10 ×0,05 em 1988→89, cumaru ×0,05 em 1987→88. Degraus em anos
  vizinhos, em produtos sem relação entre si, são a assinatura de **quebra de metodologia ou de
  cobertura**, não de safra — ou de uma restrição real (a do palmito de juçara). Não foi explicado.
  Nenhum está no catálogo, e nenhuma das 10 séries de PEVS do catálogo tem degrau nesses anos.
- **Nove categorias NOVAS de 2025, não séries "sem unidade"** (`83410`–`83418`: baru, buriti, cajá,
  cupuaçu, juçara, macaúba, pupunha, tucumã, andiroba). **Correção (2026-10-22):** a versão anterior
  deste item dizia que faltava o rótulo de unidade. Conferido linha a linha: o rótulo vem vazio só nas
  células `...` (sem dado) de 2018 a 2024; em 2025, primeiro ano em que existem, vêm em **toneladas**
  (de 38 t a juçara a 3.955 t o tucumã). Não há problema de unidade. O que vale saber antes de
  cadastrar uma delas: a série tem **um único ano**.
- **`3449` Pinheiro brasileiro (árvores abatidas)**, unidade `Mil árvores`: é contagem, e
  `unit_family_conversions` só tem `milheiro` (×1000) entre as de contagem em milhar — não tem `mil
  árvores`. Se fosse ingerida, a família cairia em `desconhecida` com `qty_base` **nulo** (o Silver
  nunca inventa uma conversão). A série em si é calma (282 mil árvores em 1993, 142 mil em 1997, 157 mil
  em 1999). O conserto é uma linha na seed: `mil árvores,contagem,un,1000`.
- **`3448` nó de pinho** (m³): **série errática, não um degrau**. A versão anterior dizia "nível ×3,5 em
  1996"; o dado é 90 mil m³ (1993), 81 mil, 71 mil, **350 mil (1996)**, **20 mil (1997)**, 280 mil
  (1998) e 499 mil (1999). Sobe e desce por fatores de 5 a 18 sem padrão, o que não é troca de
  unidade (essa deixaria um nível novo estável) e sem explicação nos dados.
- **`3462` eucalipto (folha)** (t, t291): **nível persistente em 1996**: vinha caindo (73 mil t em 1993,
  26 mil t em 1995), vai a 119 mil t em 1996 e fica em 110–120 mil t depois. Sem explicação nos dados
  (expansão real do óleo essencial ou quebra de cobertura).

## O que esta rodada mudou

Só documentação, comentários e testes (nenhum número de produção muda por este item):

- A recomendação "varra um salto de 4×" foi corrigida onde estava (`.env.example`, runbook,
  `assert_pam_quantity_no_unit_cliff`, `CLAUDE.md`): a referência é a **lista do IBGE**.
- O teste `test_pam_abacaxi_is_configured_and_lands_in_mass` afirmava o oposto da verdade
  (abacaxi em massa) e foi reescrito (`test_pam_counted_pair_is_a_count_not_a_weight`), fixando
  o pareamento com `pam_count_unit_products`.
- Comentários que chamavam o abacaxi de "só-PAM" (ele tem NCM desde a v1.100.0) foram corrigidos.
- A calibração de `AREA_FLOOR` foi **remedida com as 14 lavouras**: a maior UF excluída continua com
  972 ha (2024) e 962 ha (2025), nenhuma excluída chega a 1.000 ha, nenhum ranking fica vazio, e a
  assinatura de arredondamento (rendimento múltiplo exato de 1.000 kg/ha) é 23% abaixo de 100 ha,
  5% entre 100 e 300 ha e zero acima de 300 ha. A fronteira não se mexeu.

## Pendente

1. ~~Decidir C (opção b + a, ou só a)~~ — decidido e feito na v1.103.0: opção (b) com uma regra para as cinco séries, IGP-M começando em 1990, e o aviso (a) no painel.
2. ~~Pré-carregar as 13 frutas e fixar a lista do IBGE em teste (A)~~ — feito na v1.102.0.
3. ~~Acrescentar `mil árvores` à seed de unidades (3449)~~ — feito na v1.104.0, junto das proteções
   abaixo. **Antes de cadastrar qualquer produto de D**, ainda falta (só documentação; nada publicado
   é afetado) explicar a quebra de 1987–1990 e os níveis de 1996 (3462, 3448); as nove categorias de
   2025 só precisam de que se saiba que têm um ano de história. O comando `discover
   ibge-series-check` reproduz cada um desses achados em segundos.

## As proteções contra o que D achou (v1.104.0)

Três camadas, uma antes e uma depois de cadastrar, e uma que fecha o universo:

| camada | o que faz | medido |
|---|---|---|
| `embrapa discover ibge-series-check` | **antes de cadastrar**: lê a série nacional dos candidatos no SIDRA e relata mudança de nível persistente, unidade sem conversão, `*` fora de `pam_count_unit_products`, categoria de um ano só, buraco na série, rótulo de unidade que muda | contra o SIDRA real (2026-10-22): banana ×12,21 e laranja ×0,16 em 2001 saem como *explicados pela seed*; o marmelo (×0,25 em 2001) sai como achado; o `3449` (`Mil árvores`) passa limpo depois da linha na seed; as categorias de 2025 saem como "um ano só"; o `3462` na t289 é nomeado como código inexistente na tabela (ele é da t291, onde sai como ×3,49 a partir de 1996); o `3448` sai como um par ×3,46 em 1997 / ×0,08 em 2002, um episódio de cinco anos |
| `assert_ibge_production_no_persistent_level_shift` (warn) | **depois de ingerir**: a mesma regra em SQL sobre as três tabelas pré-agregadas do IBGE, já com a conversão aplicada | **idêntico ao Python**: 109 mudanças em 193 séries reais (6.457 pontos) das cinco tabelas; **0 linhas** nos 38 produtos em produção a 3× e 13 a 2×, por isso o fator é 3 |
| `tests/test_sidra_unit_universe.py` + 2 linhas na seed | **fecha o universo**: toda unidade de quantidade que o SIDRA usa em PAM, PEVS e PPM (medida) tem linha em `unit_family_conversions`; `Mil árvores` era a única que faltava | 5 tabelas, 7 rótulos de unidade |

**A regra** compara NÍVEIS, não degraus: a mediana dos 3 anos de um ano em diante contra a dos 3
anteriores, a ≥ 3× ou ≤ 1/3. Uma troca de unidade ou de método deixa um nível novo que fica; uma
safra, uma geada ou um surto oscila e volta, e **uma oscilação de UM ano nunca move a mediana de
três**.

**Limites, medidos, não escondidos:**

- Cego a mudança de unidade dentro da banda de 3×: dos 17 frutos do IBGE, abacate (×0,45), manga
  (×0,36), melão (×1,5) e mamão (×0,88) passam sem ser vistos. A proteção deles continua sendo a
  **lista do IBGE** na seed `pam_fruit_unit_eras`; o marmelo (×0,25), que o teste de degrau de 4×
  deixa passar por 3,97×, este pega.
- Um episódio de **dois** anos aparece como um par subida/descida, não como nada: leia o par junto.
- Uma mudança de nível é um **convite para olhar**, não prova: uma lavoura que acabou de verdade
  (juta, rami) também deixa um nível novo. A varredura da tabela inteira dá 109 mudanças em 193
  séries — é um mapa, não um alarme.
- O critério "persistente" **precisa de 3 anos de cada lado**: uma mudança nos 2 últimos anos da série
  só é vista quando o terceiro chegar.

Reprodução: `uv run embrapa discover ibge-series-check --table-id 5457 --all` (ou `-t 289`, `291`, `74`,
`3939`). A paridade Python×SQL foi medida em 2026-10-22 alimentando o SQL compilado com as séries
brutas do SIDRA no lugar da CTE `annual`.

## Reproduzir

- Série nacional de um produto na t5457: `https://apisidra.ibge.gov.br/values/t/5457/n1/all/v/214,112/p/all/c782/<código>`.
  O produto vem em `D4C`/`D4N`, o ano em `D3C`, o rótulo de unidade em `MN`.
- Razão dezembro÷média do IGP-DI:
  `select reference_year, max_by(index_value, reference_month) / avg(index_value) from silver.silver_inflation where series_code = '190' group by 1`.
- Preço corrigido por tonelada: `sum(val_real_igpdi_brl) / sum(qty_native)` em
  `serving.serving_pam_annual`, por `product_code` e `reference_year`.

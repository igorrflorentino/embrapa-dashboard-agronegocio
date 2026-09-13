# Multi-currency inflation correction

> **Status:** IMPLEMENTED in code (v1.82.0). The deflator DATA is not live yet — the
> `enable_foreign_inflation` gate ships off and turns on with the operator sequence in
> [Turning it on](#turning-it-on). Until then the new conventions are selectable and
> honestly report that they value nothing.

## Context

Until v1.81.1 the dashboard could deflate only with **Brazilian** indices — IPCA, IGP-M,
IGP-DI. The conventions strip nevertheless offered *moeda* (R$ · US$ · €) and *correção*
as two independent axes, so a researcher could pick **US$ × IPCA** and read a screen that
said, in effect, "dollars corrected for inflation, by IPCA".

The number under that label was not wrong. `val_real_ipca_usd` is
`val_raw × (IPCA_hoje / IPCA_ano) ÷ câmbio_de_hoje`: the value deflated in **reais**, then
converted at **today's** exchange rate. That is a real measurement — *Brazilian purchasing
power, expressed in dollars* — and it is a legitimate thing to want. It is simply not what
the label said, and the label's reading ("the dollar corrected for inflation") describes an
operation that did not exist anywhere in the pipeline, because no index of foreign prices
had ever been ingested.

Two defects, then, and only the second is about labels:

1. **Missing capability.** There was no way to correct a dollar by US inflation or a euro
   by euro-area inflation. For the customs bancos this is the sharper loss: COMEX and
   COMTRADE values are *declared in US$ at source*, so deflating them by US CPI is the one
   reading that involves no exchange rate at all — and it was the one reading unavailable.
2. **Misleading presentation.** With one "correção" axis, the choice looked like it was
   between *sources of index* (IBGE vs FGV) when it was really between *economies*.

## Scope

**In.** US CPI-U and euro-area HICP as ingested reference series; `val_real_cpi_usd` and
`val_real_hicp_eur` across all five Gold tables and the six serving marts; the BFF's
convention model learning which economy each index measures; the conventions strip
re-organised around that axis, with a one-line statement of what the number is.

**Out.** Deflating a *real* by a foreign index (`val_real_cpi_brl` and friends). It would
be "the dollar's purchasing power, printed in reais", which answers no question the
dashboard asks; the serving allowlist is what makes it unbuildable. Also out: any index
beyond all-items headline (core CPI, HICP ex-energy), and any currency beyond the three
the FX pipeline already carries.

## Technical design

### The distinction, stated once

An inflation index measures the prices of **one** economy, so it can only say what
something was worth in **that economy's money**. Everything else follows:

| Convention | Operation | Answers |
|---|---|---|
| R$ × IPCA | deflate in R$ | what this is worth in reais of today |
| US$ × IPCA | deflate in R$, convert at **today's** FX | Brazilian purchasing power, printed in dollars |
| US$ × CPI | convert at the **year's** FX, then deflate by US prices | what this was worth in dollars of the time, in dollars of today |

The middle and bottom rows differ by however much the **real exchange rate** moved over
the period, which across this history is a great deal. They are not two roundings of one
answer and neither corrects the other — which is why both are offered and why the screen
has to say which is active.

For a customs banco the bottom row loses its FX step entirely (`val_fob_usd` already *is*
dollars), and with it the pre-1994 hole that every BRL-routed column carries.

### Sources

Primary publishers, matching the project's rule of going to the source:

| Index | Series | Publisher | API | Key |
|---|---|---|---|---|
| CPI-U | `CUUR0000SA0` (all items, US city average, **not** seasonally adjusted) | US Bureau of Labor Statistics | `api.bls.gov/publicAPI` v1 (v2 with a key) | optional |
| HICP | `ICP.M.U2.N.000000.4.INX` (euro area, all items, 2015=100) | ECB Data Portal (SDMX) | `data-api.ecb.europa.eu` | none |

Both are **index levels**, not the monthly % change the SGS series carry, so Silver uses
them directly instead of chain-linking them. Their bases differ (1982-84=100 vs 2015=100)
and are deliberately *not* normalised: every downstream use is a ratio within one series,
which is base-invariant, so rebasing would add an anchor year that changes no number.

CPI-U is chosen over the seasonally-adjusted CPIAUCSL because the published NSA index is
never revised once out — which matters for a delta ingest that rewinds only a year.

### Pipeline

```
BLS  ─┐                                                    ┌─ val_real_cpi_usd
      ├─ bronze_foreign.inflation_raw ─ silver_foreign_inflation ─┐
ECB  ─┘   (provider · economy stored)                              ├─ silver_inflation ─ Gold
                          bronze_bcb.inflation_raw ─ silver_bcb_inflation ─┘   (union view)
```

`silver_inflation` is the counterpart of `silver_currency`: a thin union so the shared
deflation CTEs (`annual_deflation_ctes`, and COMEX's own month-grained pair) read **one**
source for every deflator. `provider` and `economy` are *stored* by the ingest rather than
derived from the series id — a second US or euro-area index would break any pattern the
moment it arrived.

### The build-order gate

`silver_foreign_inflation` reads a Bronze table that answers 404 until the first ingest,
and that failure would cascade through `silver_inflation` into **every** Gold table. So
`enable_foreign_inflation` defaults to **false**: a build-order gate, not a feature switch.

With it off nothing breaks and nothing lies. The Gold `val_real_{cpi,hicp}_*` columns still
exist (the pivot finds no rows and yields NULL), so the mart schema and the BFF allowlist
are byte-identical either way, and the screens report the absence through the same
value-gap note that already handles "this index does not reach that period" for IGP-M
before 1989 — extended here with the case where an index values *nothing at all*, which is
the one actionable cause the note used to leave unsaid.

### Enforcing the pairing

The rule "an index may correct only the money of the economy it measures" is enforced in
exactly one place that matters: **`serving.sql.ALLOWED_VALUE_COLUMNS`**, which lists
`val_real_cpi_usd` and `val_real_hicp_eur` and no other currency for them. Everything else
— the strip's disabled buttons, `clampConvention`, `effective_value_column`'s fallback —
is convenience in front of that one refusal.

`effective_value_column` treats the two kinds of unavailable combo differently, because
they are different:

* **US$ × IGP-M** (a Brazilian index with no US$ column) falls back to the same index in
  R$. The *measurement* survives the swap; only the unit changes.
* **R$ × CPI** (an index paired with money it does not measure) falls back to **nominal in
  the requested currency**. Answering with a Brazilian index would hand back precisely the
  reading the researcher declined by choosing CPI.

### The strip

The correction group is re-organised into three bands, labelled by **where the correction
happens** rather than by who publishes the index:

```
CORREÇÃO MONETÁRIA
  Sem correção                              [ Nominal ]
  Inflação do Brasil · câmbio de hoje       [ IPCA ] [ IGP-M ] [ IGP-DI ]
  Inflação da própria moeda · câmbio do ano [ CPI ]  [ HICP ]

  Deflacionado pelo IPCA — a inflação do BRASIL — e convertido ao câmbio de hoje.
  Mede poder de compra brasileiro, apresentado em dólares: não é a inflação dos EUA.
```

The band label drops its `· câmbio de hoje` suffix under R$, where no conversion happens —
announcing one that does not exist would be the same defect in the other direction. The
explanatory line (`window.conventionExplain`) is the point of the whole redesign: it states
what the number *is*, including the explicit negation, because a reader who is not told
completes the sentence themselves and completes it wrong. The collapsed chip carries the
economy too (`IPCA · Brasil`), so the distinction survives the strip being closed.

## Tasks

- [x] `foreign_inflation/` ingestion package (BLS + ECB clients, two-phase raw→Bronze)
- [x] `cli.INGESTS` · `doctor.SOURCE_CHECKS` · `doctor.BRONZE_TARGETS` registrations
- [x] `silver_foreign_inflation` + `silver_inflation` union view + `economy` column
- [x] `annual_deflation_ctes` and COMEX's month CTEs read the union, pivot cpi/hicp
- [x] `val_real_cpi_usd` / `val_real_hicp_eur` in 5 Gold tables + 6 serving marts
- [x] serving allowlist · `format.py` conventions model · `seam.effective_value_column`
- [x] conventions strip bands + `conventionExplain` + chips + `clampConvention`
- [x] value-gap note names an index that was never ingested
- [x] glossary · ARCHITECTURE · CLAUDE.md · README · CHANGELOG
- [ ] **operator**: register the BLS key, deploy the ingestion Job, run the backfill,
      flip the dbt var (below)

## Turning it on

The code ships with the deflators declared and the data absent. **Five** steps, in order —
it was four until v1.83.0 added the BLS key, and the key comes FIRST because
`deploy.sh` mounts it while building the Job, so a key registered afterwards means
deploying twice.

```bash
# 1. register the BLS key (once per project) — see deploy/ingestion/deploy.sh § 3c for the
#    create-secret + secretAccessor commands, then put BLS_KEY_SECRET=bls-api-key in .env
make ingest-job-deploy                              # 2. Job image carries the new source + the key
uv run embrapa doctor                               # 3. both publishers answer, with the key live
gcloud run jobs execute embrapa-ingest-all \
  --args=ingest,foreign-inflation,--full            # 4. one 1974→today backfill
#                                                     5a. set DBT_ENABLE_FOREIGN_INFLATION=true
gh workflow run dbt-build-prod.yml --ref main       # 5b. rebuild so Gold materializes the columns
```

**Why the key is not optional in practice.** The keyless v1 endpoint allows 25 requests/day
counted **per calling IP** — not per project and not per key. The backfill needs only 6 of
them (10-year windows over 1974→today), and that arithmetic is what the original design
relied on; it is also exactly the premise that failed. The Job shares its egress address
with everything else leaving from it and can find the cap already spent without having made
a single request — measured 2026-09-13, when BLS answered `REQUEST_NOT_PROCESSED` (HTTP 200,
zero observations) to a *first* call. A registered key moves the call to v2, whose 500/day
quota is the **key's** and whose windows are 20 years wide, so the same backfill costs 3
requests against a cap nobody else can spend.

That is also what makes step 3 worth its place. `doctor` runs from the operator's machine,
a different egress address than the Job — so while the quota is per-IP, a local pass proves
nothing about what the Job will meet. Once the quota belongs to the key, both call the same
cap and the probe becomes predictive. Run it keyed, or not at all.

**Step 4 is the real verification.** Both APIs were specified from their published contracts
but could not be exercised from the build environment (outbound HTTPS to `api.bls.gov` and
`data-api.ecb.europa.eu` is blocked there). ECB has since answered a live call; BLS has not
yet answered a successful one. A typo'd or retired series id fails **loudly** by design —
`extract` raises naming the offending series rather than reporting success with an empty
deflator — and since v1.82.1 a quota refusal fails loudly too, instead of being certified
as a healthy 200.

### Pre-flight: what was already verified, so step 4 only tests the APIs

Measured against **production** on 2026-09-13, after the v1.83.2 build. The plumbing
between the two APIs and the Gold columns cannot be exercised before turn-on — but every
link in it can be checked statically or against the live schema, and was:

| Link | How it was checked | Result |
|---|---|---|
| Bronze column names | the 7 fields `pipeline.py` declares vs. the 7 `silver_foreign_inflation` reads | identical |
| Date format | both clients emit `dd/mm/yyyy`; the model parses `'%d/%m/%Y'` | match |
| `silver_inflation` union | the foreign leg's 10 columns vs. the live BCB leg in prod, by position and type | identical |
| Gold / mart columns | `INFORMATION_SCHEMA` on prod `gold` + `serving` | present in all 5 facts and 6 marts, `FLOAT64` |
| Gate-off behaviour | non-null counts on three marts | `val_real_cpi_usd` / `val_real_hicp_eur` = 0 non-null; `val_real_ipca_brl` populated |

The date format was the one worth checking rather than assuming: a mismatch makes
`safe.parse_date` return NULL, the model's `where … is not null` then drops **every** row,
and the deflator comes out empty with no error anywhere. BLS builds `01/{month:02d}/{year}`
and the ECB side validates `TIME_PERIOD` against `\d{4}-\d{2}` before splitting it, so the
two-digit month is guaranteed on both.

So if step 4 fails, the cause is upstream of this repo — a quota refusal, a retired series
id, credentials — not the pipeline shape. That is a narrower search than it would otherwise
be.

**Step 5 is the one that is dangerous out of order.** Flipping the var while Bronze is still
empty points `silver_foreign_inflation` at a dataset that does not exist, and that failure
cascades through `silver_inflation` into every Gold table — the whole reason the gate exists.
Do not set it until step 4 has actually written rows.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Prod `dbt build` breaks because Bronze is absent | `enable_foreign_inflation` defaults false; Gold column shape is identical either way |
| A series id is wrong and the deflator stays empty | cold-empty series raises naming itself (`test_foreign_inflation.py`); `doctor` probes both publishers separately |
| BLS quota refused before a single request | the keyless 25/day is counted per EGRESS IP and shared, so window arithmetic does not bound it (measured 2026-09-13); `BLS_KEY_SECRET` moves the call to v2, where the 500/day is the key's own. The refusal arrives as HTTP 200 + a status string — classified transient by the client, and no longer certified healthy by `doctor` (v1.82.1) |
| The two readings get conflated again | `test_the_two_correction_logics_get_different_labels_under_the_same_symbol`, the `_gold.yml` unit test where both indices triple so only the FX moment can explain 600 vs 1500, and the `_IMPOSSIBLE_PAIRS` allowlist sweep |

## Acceptance criteria

* `US$ · CPI` and `US$ · IPCA` resolve to different columns and carry different labels.
* No screen presents a foreign currency corrected by a Brazilian index without saying so.
* `R$ · CPI` cannot be selected, cannot be deep-linked, and cannot be served.
* With the gate off, every existing number is unchanged and the new conventions report
  their own absence.

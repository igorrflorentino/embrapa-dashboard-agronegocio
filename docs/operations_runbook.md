# Operations Runbook

Occasional, get-it-right operational procedures for the prod deployment — the
things you don't do every day and that bite you on a fresh machine. Day-to-day
commands live in [`README.md`](../README.md) / [`CLAUDE.md`](../CLAUDE.md); this
is the "how do I safely do X against prod" reference.

## Managing attribute editors (who may save curation edits)

The curation write endpoints (`POST /api/attributes/*`) are gated by an
**authorization allowlist**, distinct from IAP authentication. The effective
allowlist is the **union** of:

- the `ATTRIBUTE_EDITORS_ALLOWED_EMAILS` env var (comma-separated), and
- the Console-managed BigQuery table `<dataset>.attribute_editors`
  (`<dataset>` = `BQ_RESEARCH_INPUTS_DATASET`, default `research_inputs`; table
  name = `BQ_ATTRIBUTE_EDITORS_TABLE`, default `attribute editors`).

If **both** are empty/absent, any IAP-authenticated caller may curate (open mode).

**Add/remove an attribute editor without a redeploy** — edit the table in the BigQuery
Console (or via SQL). No deploy, no code change:

```sql
-- add
INSERT INTO `<project>.research_inputs.attribute_editors` (email, added_by, added_at)
VALUES ('new.attribute editor@embrapa.br', 'you@embrapa.br', CURRENT_TIMESTAMP());

-- remove
DELETE FROM `<project>.research_inputs.attribute_editors` WHERE email = 'old@embrapa.br';

-- list current
SELECT email FROM `<project>.research_inputs.attribute_editors` ORDER BY email;
```

Notes:
- Changes take effect within the classification cache TTL
  (`CACHE_CLASSIFICATION_TIMEOUT`, ~30s) — no instant invalidation needed.
- Emails are matched case-insensitively (lower + trim).
- The table auto-creates on the **first curation write attempt**: the curation
  POST authorization path (`routes._authorize_attribute_editor`) calls
  `serving.research_inputs.ensure_attribute_editors_table` (idempotent), so it exists for the
  Console INSERT above the first time anyone tries to save an edit. The runtime SA
  needs write access to the dataset to create it — the prod web SA
  `sa-web-dashboard-prod` already has WRITER on `research_inputs`. (If you prefer
  to create it up front, before any write, run the INSERT against the dataset and
  it self-heals, or call the helper directly.)
- Curation writes also accept an optional client `change_id` (idempotency key):
  a retried/double-clicked save reusing the same key is a no-op, not a duplicate
  audit row.

## Managing catalog editors (the "Cadastro de produtos" admin view)

The **live Curadoria catalog** edits (the "Cadastro de produtos" admin view → the catalog
write routes) are gated by a **per-catalog** allowlist, separate from the curation attribute editors
above: the Console-managed table `<dataset>.catalog_editors` (`<dataset>` =
`BQ_RESEARCH_INPUTS_DATASET`, default `research_inputs`; table = `BQ_CATALOG_EDITORS_TABLE`,
default `catalog_editors`), keyed by `(resource, email)` where `resource` is the catalog id
(`produto_catalog`). If **no** rows exist for a resource, any IAP-authenticated caller may
edit that catalog (open mode); add a row to lock it down.

```sql
-- add an editor for the produto catalog
INSERT INTO `<project>.research_inputs.catalog_editors` (resource, email, added_by, added_at)
VALUES ('produto_catalog', 'new.editor@embrapa.br', 'you@embrapa.br', CURRENT_TIMESTAMP());

-- remove
DELETE FROM `<project>.research_inputs.catalog_editors`
WHERE resource = 'produto_catalog' AND email = 'old@embrapa.br';

-- list current
SELECT email FROM `<project>.research_inputs.catalog_editors`
WHERE resource = 'produto_catalog' ORDER BY email;
```

Like the attribute editors table: changes take effect within the ~30s classification cache TTL, emails are
matched case-insensitively, and the table **auto-creates on the first catalog write attempt**
(`routes._ensure_catalog_editors_table` → `serving.curation.ensure_catalog_editors_table`,
idempotent; the prod web SA `sa-web-dashboard-prod` already has WRITER on `research_inputs`).

## Curadoria orphan lifecycle: `mark-orphans` and `purge-orphan`

When a commodity is removed from the live Curadoria catalog, its already-ingested Gold
data does **not** vanish — it lingers as an *orphan*. The lifecycle that resolves this is
deliberately split: **detection + marking is automatic and NON-destructive; the actual
delete is human-gated and backup-first.** Both commands require the `webapi` extra
(`uv run --extra webapi embrapa …`) and append to the append-only
`research_inputs.catalog_lifecycle_log`.

### `mark-orphans` — auto-mark orphans Descontinuado (safe, idempotent)

```bash
uv run --extra webapi embrapa mark-orphans
```

Detects orphans (a catalog removal that left Gold data behind — not every uncataloged Gold
code) and appends a `descontinuado` lifecycle event carrying a deletion warning. It
**never deletes data**, is **idempotent** (re-running is a no-op), and its author is the
reserved SYSTEM identity `system:orphan-detector`. Run it on the ops cadence — e.g. right
after a prod `dbt build` (scheduled Mondays and Thursdays, on every push to `main` that
touches `dbt/**`, or dispatched by hand), on the
same boundary the catalog diff is computed.

### `purge-orphan` — human-gated, backup-first Gold delete

```bash
# 1. Print the scoped DELETE plan (backup-gated; nothing is deleted):
uv run --extra webapi embrapa purge-orphan --banco pevs --code 3405

# 2. After you have run the printed DELETEs yourself, record the terminal event:
uv run --extra webapi embrapa purge-orphan --banco pevs --code 3405 --mark-purged
```

`purge-orphan` **never deletes anything itself** — by default it only **prints** the
scoped `DELETE` statements for you to run manually (the repo's destructive-command hooks
block `bq rm` / `DROP` for automation anyway; see *Destructive-command safety hooks*
below). Two guards:

- **Backup-first hard gate.** Without a fresh Gold snapshot the DELETEs are **not even
  printed** — run `make dbt-build-prod-with-backup` first. `--force` overrides the gate
  and prints them anyway with a warning (NOT recommended: no restore point).
- **Descontinuado-only.** Only a code currently marked Descontinuado (by `mark-orphans`)
  can be purged; a re-added or never-marked code is refused.

`--mark-purged` appends the terminal `purged` audit event **after** you have run the
DELETEs (who/when — it does not delete data). It is idempotent per descontinuado
generation. `--author` stamps who purged; it defaults to the OS login user
(`operator:<user>`) so the audit row names a real operator — pass
`--author you@embrapa.br` to record a specific identity.

> **Permanence caveat.** Gold is rebuilt from Bronze by dbt, so the DELETEs alone are
> temporary. For a purge to survive the next build you must ALSO: (1) delete the matching
> Bronze rows; (2) rebuild the affected Silver models with `--full-refresh`
> (`silver_ibge_pevs` / `silver_comtrade_flows` are incremental and otherwise retain the
> rows); (3) drop the product from the ingestion scope (`config.py` or the catalog).
> Otherwise the data returns on the next `dbt build` while the lifecycle stays `purged` —
> a silent divergence. The command prints this reminder after the plan.

Spec: [`PLANS/curadoria_catalogo.md`](../PLANS/curadoria_catalogo.md).

## Q1 quality outlier/problemático detection (enable / revert)

`data_quality_flag` carries the 4 implied-price tiers (`OUTLIER_*` / `PROBLEMATIC_*`) only when the
dbt var `enable_quality_outliers` is `true` — it is **on in prod**. The setting lives in
`dbt/dbt_project.yml`, so the scheduled `dbt-build-prod` picks it up automatically; flipping it
requires a **Gold rebuild** (it rewrites `data_quality_flag` row-by-row). After a build, sanity-check
the per-source problemático rates (of all rows: PEVS ≈0.0009% / COMEX ≈0.0057% / PAM ≈0.020% / PPM
≈0.0003% / COMTRADE ≈0.15%). To **revert**: set `enable_quality_outliers: false` + rebuild → the gold
models compile byte-identical to the legacy 4-value flag (the flag is recomputed from Silver every
build — fully reversible, no data loss). Full method + spec:
[`PLANS/quality_outliers_and_visibility_gate.md`](../PLANS/quality_outliers_and_visibility_gate.md).

## Changing a banco's maturity / note / coverage without a redeploy

The dashboard's per-banco lifecycle metadata — **maturity stage** (`planejado` ·
`desenvolvimento` · `ingestao` · `beta` · `estavel` · `manutencao` · `descontinuado`), the
caveat **note**, the planned **date**, and the **coverage** labels — has its
defaults baked in `registries.py` (backend) and `bancos.js` (the SPA). Those are
the source of truth, but editing them needs a rebuild + Cloud Run redeploy.

For the common operational change (e.g. promoting a banco `beta → estavel` once
its backfill lands, or refreshing a coverage label), there is a **Console-managed
override table** — no rebuild, no redeploy:

- `<dataset>.banco_metadata` (`<dataset>` = `BQ_RESEARCH_INPUTS_DATASET`, default
  `research_inputs`; table name = `BQ_BANCO_METADATA_TABLE`, default
  `banco_metadata`). One **sparse** row per banco you have touched: each column is
  an override; a `NULL` column (or no row at all) falls back to the registry
  default. The API merges it into `/api/source-meta`, so the SPA's MaturityTag /
  MaturityBanner / coverage chips reflect the edit.

```sql
-- Promote UN COMTRADE beta → estavel (removes the caveat banner):
MERGE `<project>.research_inputs.banco_metadata` t
USING (SELECT 'un_comtrade' AS banco_id, 'estavel' AS maturity) s
ON t.banco_id = s.banco_id
WHEN MATCHED THEN UPDATE SET maturity = s.maturity, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (banco_id, maturity, updated_at)
  VALUES (s.banco_id, s.maturity, CURRENT_TIMESTAMP());

-- Update only the coverage label (leave maturity on the registry default):
MERGE `<project>.research_inputs.banco_metadata` t
USING (SELECT 'ibge_pam' AS banco_id, '1974 → presente' AS cobertura_years) s
ON t.banco_id = s.banco_id
WHEN MATCHED THEN UPDATE SET cobertura_years = s.cobertura_years, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (banco_id, cobertura_years, updated_at)
  VALUES (s.banco_id, s.cobertura_years, CURRENT_TIMESTAMP());

-- Revert a banco to its registry default (drop the override row):
DELETE FROM `<project>.research_inputs.banco_metadata` WHERE banco_id = 'un_comtrade';
```

Override columns: `maturity`, `maturity_note`, `maturity_date`, `cobertura_years`,
`cobertura_atualizacao`, `cobertura_granularidade`. Notes:
- `maturity_note` **REPLACES** the stage's standard caveat text for that banco — it is
  not appended to it. So a banco with a note stops showing "Disponível para testes e
  validações, resultados podem mudar." and shows the note instead, for every reader.
  Use it ONLY for a caveat that is true of THAT banco and not of its stage — the way
  `sefaz_nf` does ("Contrato provisório — sem fonte confirmada neste projeto."). A
  description of what the banco **covers** is not a caveat and belongs in `bancos.js`
  (`sub` / `about` / `domain`); pasted into this column it silently displaces the
  standard message. That is what happened to `ibge_ppm` between 2026-06-20 and
  2026-08-28 (v1.33.6). To clear one: `UPDATE … SET maturity_note = NULL WHERE banco_id = '…'`.
- Changes take effect within the classification cache TTL
  (`CACHE_CLASSIFICATION_TIMEOUT`, ~30s) — no redeploy, no invalidation needed.
- The table auto-creates on the **first `/api/source-meta` read**
  (`routes._ensure_banco_metadata_table`, idempotent). The prod web SA
  `sa-web-dashboard-prod` already has WRITER on `research_inputs`.
- `maturity` must be one of the seven stage ids above (`ingestao` = pipeline built but data
  still loading, order 3, no data yet; an unknown id falls back to
  `planejado` rendering in the SPA). Keep the registry the long-term source of
  truth: fold a lasting change back into `registries.py` + `bancos.js` at the next
  release so the default and the override agree.
- **Then DROP the override** (`SET <col> = NULL`) — do not leave it duplicating the
  value you just folded back. A duplicate that agrees today is precisely what goes
  stale tomorrow: `un_comtrade` carried `cobertura_years = '1989 → presente'` next to a
  registry that said the same, so nothing looked inconsistent, and when the v1.13.0
  redesign moved the real floor to 2000 BOTH copies were wrong and neither could notice
  (v1.33.7). `ibge_pam`/`ibge_ppm` were dropped the same way in v1.33.8 while still
  matching — the cleanup is a no-op for the reader by design. **Never NULL `maturity`
  itself**: it has no registry fallback, so an emptied row leaves the banco showing the
  neutral "…" loading tag forever. Clear the `cobertura_*` / note columns, keep the row.

## Um ✓ verde do `doctor` que diz `skipped:` — leia com atenção

`embrapa doctor` distingue **duas** razões para um check não produzir veredito, e desde a
v1.46.4 elas têm cores diferentes:

- **`skipped:` (verde)** — não há dado para julgar. A tabela não existe, falta permissão de
  leitura, não há ADC, ou o BigQuery está fora do ar. Legítimo numa instalação fria ou numa
  máquina de dev sem acesso ao prod; não é defeito do projeto.
- **`CHECK QUEBRADO (…)` (vermelho)** — o check em si falhou: a consulta não compila porque
  uma coluna foi renomeada, ou o código levantou `TypeError`/`KeyError`. **O doctor está
  degradado**, e o número de ✓ no rodapé não significa o que parece.

Vale inclusive para os checks *advisory*: "advisory" governa o que o check faz quando
**consegue** julgar. Quando não consegue rodar, o operador precisa saber.

**Por que a distinção existe.** Até a v1.46.3, seis checks devolviam verde para qualquer
exceção. Um deles — `Shared code across SIDRA tables` — consultava a coluna `origem`,
removida do Gold na v1.46.1. Passou a receber `400 Unrecognized name`, respondeu com um ✓
verde e um `skipped:` ao lado, e ficou assim por três versões: o guarda do invariante
daquela própria migração, cegado por ela. Num relatório de 27 linhas verdes, um `skipped:`
não se lê.

Se você vir `CHECK QUEBRADO`, o conserto é no check, não no ambiente.

## Is a source still arriving? — `embrapa doctor` § Source data freshness

The ingestion alert (`deploy/ingestion/alert_policy.json`) fires on a **failed** Cloud Run
execution. A monthly trigger that runs green and ingests **nothing** looks exactly like
"the source has not published yet" — and for the annual sources (IBGE PEVS/PAM/PPM,
COMTRADE) that quiet state is normal ~11 months a year, so a real stall could sit unnoticed.

`embrapa doctor`'s **Source data freshness** check closes the half of that gap which is
knowable from the data: for every row of `gold_source_metadata` it compares `year_end`
against what the row's own `cadence` implies —

- `annual` → must be ≥ `current_year − SOURCE_FRESHNESS_ANNUAL_SLACK_YEARS` (default **2**:
  one full year of slack beyond the ~1yr publication lag, so it trips only after a
  publication window passed WITHOUT the new year arriving);
- `monthly` → must be ≥ `current_year − 1` (January still carries December).

It **warns**, never fails: a lagging source is a reason to look, not a broken environment.

**What it cannot do**, deliberately: tell a healthy quiet source from a broken one BETWEEN
publication windows — the data is identical in both cases. It catches the stall at the
window, not before it.

That other half is now covered by the **Ingest heartbeat** check. Every ingest run writes
one row to `research_inputs.ingestion_heartbeat` (source, timestamp, outcome, duration)
**whether or not it had anything to ingest** — so the three states finally separate:

| what you see | what it means |
|---|---|
| no row inside the source's window | the **trigger** did not fire — check Cloud Scheduler and the Job's executions |
| row, `outcome='ok'`, data unchanged | it ran and the source had nothing new — the healthy quiet state |
| row, `outcome='failed'` | it ran and broke — the Cloud Monitoring alert also fires |

Windows come from each source's own `IngestSpec.cadence_days` in `cli.INGESTS` (1 for BCB
câmbio, 7 for the weekly batch, 31 for the monthly triggers) plus `HEARTBEAT_SLACK_DAYS`
(default 3) of grace — so a daily source trips at 4 days, a weekly one at 10, a monthly one
at 34. That cadence is declared per source rather than inferred from `in_all`, which stopped
meaning "daily" when the batch went weekly. A source that has NEVER reported is not flagged
— the table only fills forward from the day this shipped.

The heartbeat write can never fail an ingest (`ingestion_heartbeat.record` swallows every
error with a warning): a monitor that can take down what it monitors is worse than none.

To see the raw trail, including the runs that ingested nothing:

```sql
SELECT source, run_ts, outcome, duration_s
FROM `<project>.research_inputs.ingestion_heartbeat`
ORDER BY run_ts DESC LIMIT 50;
```

## IAP author verification — set `IAP_AUDIENCE` in prod

Curation writes attribute every edit to a person (`edited_by`). That author can
come from two places, and **which one is active depends on `IAP_AUDIENCE`**:

- **`IAP_AUDIENCE` set** (production): the author is read from the **signed
  `X-Goog-IAP-JWT-Assertion`**, cryptographically verified against this
  audience. A direct request to the backend cannot forge the audit author, and
  an ingress misconfiguration (e.g. an accidentally public service) fails
  closed.
- **`IAP_AUDIENCE` unset**: the in-app JWT double-check is **skipped**. With Cloud
  Run **direct IAP** enabled (the prod posture), the platform still authenticates
  every request and **overwrites** the `X-Goog-Authenticated-User-Email` header, so
  author capture stays trustworthy — the in-app check is defense-in-depth. The
  header is only spoofable when IAP is **not** in front (e.g. local dev), which is
  why this mode is paired with `DEV_AUTHOR` for local dev only.

> **Note (2026-06):** with **Curadoria frozen**, the live consumer of this verified
> identity is the **feedback channel** — `submitted_by` in `feedback_log` flows
> through the same `serving/iap.py` path, and the per-author feedback cooldown
> (SEC-2) only engages when `IAP_AUDIENCE` is set. So this stays a prod concern even
> though curation writes are dormant — keep it armed.

Operator steps (one-time per deployment):

1. Get the audience string: Console → Security → Identity-Aware Proxy → ⋮ on the
   **Cloud Run resource** → "Get JWT audience code" (the direct Cloud Run IAP form).
   *(Only in the future external-LB + IAP topology would it instead take the form
   `/projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>`.)*
2. Set `IAP_AUDIENCE=<that string>` in **`deploy/webapi/.env.prod`** (copy
   `deploy/webapi/.env.prod.example`). That git-ignored file holds prod-only env
   that must NOT live in the dev/worktree repo-root `.env`; `deploy.sh` layers it on
   top of `.env` (prod values win), so a routine `make webapi-deploy` **keeps**
   `IAP_AUDIENCE` armed instead of dropping it — which previously forced an
   out-of-band / image-only deploy to restore. (`FEEDBACK_GITHUB_REPO` belongs here
   too.) Then run `make webapi-deploy`.

   > ℹ️ This is the **env-change** path, and the only one that needs `.env.prod`. A
   > **code-only** change needs none of this: merging to `main` triggers
   > `.github/workflows/webapi-deploy.yml`, which swaps ONLY the image
   > (`gcloud run services update --image`) and leaves env, secrets and the IAP
   > annotations untouched. Don't reach for `deploy.sh` to ship code — from a machine
   > without `.env.prod` it would strip `IAP_AUDIENCE` and disarm the in-app IAP check.
3. Verify: a curation save in prod records the IAP identity; with a wrong
   audience the write is rejected rather than silently mis-attributed.

Details: `src/embrapa_dashboard/serving/iap.py` and
[`docs/auth_architecture.md`](auth_architecture.md).

## Curation in the prod build (`enable_curation`)

> **Status (2026-09-24): LIVE.** The per-code *Nível de industrialização* curation has been
> active in prod since 2026-07-05 (#218 unfroze it). `dbt_project.yml` sets
> `enable_curation: true`, so EVERY build — CI, the scheduled/dispatched `dbt-build-prod`
> workflow, `make dbt-build-prod`, `make reconcile`, a plain local `dbt build` — builds
> `dim_code_industrialization_scd2`. Only the *Tipo de mercado* axis is still FROZEN, and
> it is data-blocked rather than gated by this var (see CLAUDE.md, "Engenharia de
> Atributos"). An earlier version of this section said the whole curation was frozen and
> must not be activated; that stopped being true in July.

The var still exists for a **fresh** project, where the curation log tables are not there
yet and the SCD2 model would fail on its missing source: build it with
`enable_curation: false` until `make ensure-curation` provisions the logs (the per-code
log also auto-creates on the first editor write).

The repo variable `DBT_ENABLE_CURATION=true` makes the `dbt-build-prod` workflow also put
`enable_curation: true` in its `--vars` mapping. Because the project default is already
true, the variable only reasserts it — **unsetting it does NOT turn curation off**; that
takes the project default.

> ⚠️ **One `--vars` per command — dbt keeps only the LAST one.** It does not merge them:
> `--vars 'enable_curation: false' --vars 'enable_foreign_inflation: true'` compiles
> `enable_curation` as the project default (measured on dbt 1.11.10 and 1.12.5, v1.88.4).
> Until v1.88.4 the workflow itself passed one flag per repo variable, so the curation flag
> never reached dbt. And a direct prod build must carry the foreign-deflator gate too, or
> every `val_real_{cpi,hicp}_*` column is rebuilt NULL without any error. So, for a direct
> prod build, one mapping with both:
>
> ```bash
> bash scripts/dbt-with-env.sh build --target prod --vars '{enable_curation: true, enable_foreign_inflation: true}'
> ```
>
> Prefer `make dbt-build-prod` (or `gh workflow run dbt-build-prod.yml --ref main`), which
> already pass the right vars.

## Triaging user feedback ("Reportar problema")

The dashboard's **Reportar problema** button writes each report (bug / dúvida / sugestão)
to the append-only `research_inputs.feedback_log` BigQuery table (auto-created on first
write), with the submitter captured from IAP and a permalink to the current view/filters
attached. Triage by querying the table:

```bash
bq query --use_legacy_sql=false \
  "SELECT submitted_at, category, submitted_by, message, url, issue_url
   FROM \`${GCP_PROJECT_ID}.research_inputs.feedback_log\`
   ORDER BY submitted_at DESC LIMIT 50"
```

Reply to the reporter directly — their e-mail is the `submitted_by` column.

**Closing the loop with GitHub (optional).** Each report is ALSO opened as a GitHub issue
(labelled `feedback` + category) when the service has `FEEDBACK_GITHUB_REPO` (`owner/name`)
**and** the `FEEDBACK_GITHUB_TOKEN` secret. The forward is best-effort — if GitHub is
unreachable the report is still durably in BigQuery (`issue_url` then null), never lost or
blocked.

Wire it up (one-time):

1. Create a **fine-grained** GitHub token scoped to **only** that repo with **Issues:
   Read and write** (not a broad classic PAT), then store it in Secret Manager:

   ```bash
   printf '%s' "<TOKEN>" | gcloud secrets create feedback-github-token \
     --data-file=- --project="$GCP_PROJECT_ID"
   gcloud secrets add-iam-policy-binding feedback-github-token \
     --member="serviceAccount:sa-web-dashboard-prod@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor" --project="$GCP_PROJECT_ID"
   ```

2. Set `FEEDBACK_GITHUB_REPO` in the deploy `.env` (it is in the deploy allowlist). The token
   is mounted automatically: `deploy/webapi/deploy.sh` adds
   `--set-secrets FEEDBACK_GITHUB_TOKEN=feedback-github-token:latest` whenever the secret
   exists (override the name with `FEEDBACK_GITHUB_TOKEN_SECRET`), so a routine redeploy
   **keeps** the loop active — it is never a plaintext env var.

## The BLS API key (foreign deflators): where it lives, rotating it, verifying it

The US CPI-U deflator needs a registered BLS key: the keyless v1 endpoint IGNORES
`startyear/endyear` and answers only the latest three years, so without the key no
backfill can reach 1974 (see `PLANS/correcao_inflacionaria_multimoeda.md`).

| What | Where |
|---|---|
| The key | Secret Manager `bls-api-key` (versions; the Job reads `:latest`) |
| Who may read it | `sa-data-pipeline-prod` — `roles/secretmanager.secretAccessor` on that secret only |
| How the Job gets it | env `BLS_API_KEY` ← `bls-api-key:latest` (mounted 2026-09-23) |
| Local runs | `BLS_API_KEY` in the process env — never written to `.env` or a commit |

**Rotating** (or setting it the first time). A new version is enough — the mount reads
`:latest` at each execution, so nothing else changes. Run as-is; paste the key only at the
prompt. The format guard refuses anything that is not 32 hex characters, which is what a
BLS key is — it exists because a password once went into the secret in its place:

```powershell
$P = 'embrapa-dashboard-commodities'
$s = Read-Host 'BLS key (32 hex characters, from the e-mail)' -AsSecureString
$k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
if ($k -notmatch '^[0-9a-fA-F]{32}$') { Write-Host 'Not a BLS key. Nothing stored.' -ForegroundColor Red }
else { $t = New-TemporaryFile; [IO.File]::WriteAllText($t.FullName, $k); gcloud secrets versions add bls-api-key --data-file="$($t.FullName)" --project $P; Remove-Item $t.FullName -Force }
Remove-Variable s, k, t -ErrorAction SilentlyContinue
```

`WriteAllText` instead of a pipe is deliberate: PowerShell 5.1 appends `\r\n` to a string
piped into a native program, and the secret would be stored as `key\r\n`. A new key must
also be ACTIVATED through the link in the BLS e-mail before it works.

**Verifying without reading the value** — metadata only:

```bash
gcloud secrets versions list bls-api-key --project embrapa-dashboard-commodities
gcloud run jobs describe embrapa-ingest-all --region us-central1 --project embrapa-dashboard-commodities --format='value(spec.template.spec.template.spec.containers[0].env[].name)'
```

The real test is a run: `gcloud run jobs execute embrapa-ingest-all --region us-central1
'--args=foreign-inflation' --wait`, then the coverage query in the PLANS runbook.

**If a WRONG value was stored** (what happened on 2026-09-23). BLS repeats a refused key
verbatim in its error ("The key:… provided by the User is invalid"); since v1.85.0 the
client scrubs it, but an older image copied it into the Job's stderr and into
`research_inputs.ingestion_heartbeat.detail`. The clean-up, in this order:

1. Stop further use: `gcloud run jobs update embrapa-ingest-all --region us-central1
   --remove-secrets BLS_API_KEY` (restores the keyless Job; remount later with
   `--update-secrets BLS_API_KEY=bls-api-key:latest`). Unmount BEFORE disabling the
   version — a mount pointing at a disabled `:latest` fails the WHOLE execution.
2. `gcloud secrets versions disable <n>`, then `… destroy <n>` (permanent — a human step).
3. Redact the heartbeat rows (keeps the failure record, drops the value). From PowerShell,
   collapse the SQL to one line — `bq` is a `.cmd`, and cmd.exe reads only the first line
   of a multi-line argument (the first attempt ran just `UPDATE <table>` and failed):
   `UPDATE research_inputs.ingestion_heartbeat SET detail = REGEXP_REPLACE(detail,
   r'The key:\S+ provided', 'The key:[removido] provided') WHERE source =
   'foreign-inflation' AND STRPOS(detail, 'provided by the User is invalid') > 0` —
   `bq query --dry_run` first. BigQuery time travel keeps the old rows for 7 days.
4. Cloud Logging entries cannot be deleted one by one (only the whole `stderr` log); they
   expire with the `_Default` bucket (30 days). If the value was a password, change it —
   it also reached BLS's servers in a URL, which nothing here can recall.

**PowerShell and `gcloud` lists.** Quote any comma-separated value
(`'--args=foreign-inflation,--full'`, `'--remove-env-vars=A,B'`): unquoted, the comma is
PowerShell's array operator, `gcloud.ps1` joins the array with a space, and gcloud gets ONE
token. `--remove-env-vars A,B` answered "successfully updated" while removing nothing — only
a before/after diff of the Job showed it.

## Editing a dbt seed (currency factors, unit conversions) → run `--full-refresh`

**⚠ A seed edit does NOT propagate on a plain `dbt build`.** `silver_ibge_pevs` is
incremental (insert_overwrite by `reference_year`) and its incremental gate keys off NEW
Bronze `ingestion_timestamp`s only. A seed edit bumps none, so the corrected values never
reach the already-built partitions — most dangerously the **pre-1994 partitions** that
depend on `historical_currency_factors` for the currency-reform correction. The same holds
for `unit_family_conversions` and `product_unit_factors`.

After editing any of those seeds, rebuild the affected model(s) with a full refresh, e.g.:

```bash
# prod, via the GitHub Actions "dbt build prod" workflow with full_refresh=true, OR locally:
scripts/dbt-with-env.sh build --select silver_ibge_pevs+ --full-refresh --target prod
```

Do this at the release boundary and re-run `embrapa doctor` after. (The dbt guard tests —
`assert_currency_factor_no_overlap`, `assert_pre1994_real_per_unit_bounded`, … — are
post-hoc: they validate the built output, so they only re-fire once Silver is reprocessed.)

## Backing up prod Gold from a local / dev machine

`embrapa backup-gold` snapshots the Gold tables to
`gs://<bucket>/backups/run=<ts>/`, plus the two things no build can recreate:
the authored `research_inputs` tables under `_curation/`, and the append-only
serving tables (`backup.HISTORY_TABLES`, today `serving_quality_history`) under
`_history/` (since v1.93.2). The `_SUCCESS` manifest lists all three groups, and
`embrapa doctor` fails `curation-backup` / `history-backup` when the newest snapshot
predates either coverage. Check which dataset a run copied with
`gcloud storage cat gs://<bucket>/backups/run=<ts>/_SUCCESS` (`"dataset": "gold"`
is prod). Two gotchas when running it **locally**
(outside the prod-targeted CI / Makefile path):

1. **It targets the DEV gold dataset by default** — a local `.env` resolves
   `BQ_GOLD_DATASET` to `dbt_dev_gold`, so a bare run snapshots dev, not prod.
   Override with `BQ_GOLD_DATASET=gold`.
2. **The impersonation SA can't write GCS** — the configured
   `GCP_IMPERSONATION_SA` (`sa-secret-reader-prod`) lacks object-write on the
   datalake bucket (403). Clear it so the client uses your own ADC.

Correct standalone local **prod** snapshot:

```bash
BQ_GOLD_DATASET=gold GCP_IMPERSONATION_SA= uv run embrapa backup-gold
```

The prod path `make dbt-build-prod-with-backup` sets the prod target itself, so
this override is only needed for a one-off local backup. `embrapa doctor` warns
when the latest snapshot is older than `BACKUP_STALENESS_DAYS` (default 14).

## Pruning superseded Bronze rows (IBGE PEVS extração / PAM) — done 2026-09-26

Bronze is append-only, and every full re-ingest (`reconcile`, `--full`, a retried
failure) appends another copy of the whole history. Silver reads ALL of it on every build
(its `>=` boundary re-includes every year — see the header of `silver_ibge_pevs.sql`) and
its dedupe `qualify` throws the copies away. So the copies cost scan on every build, not
storage: the table is 6.8 GB logical but 146 MB physical.

**Why it was done (measured 2026-09-25/26):**
- The project billed **2.63 TiB of queries in 30 days**, above BigQuery's free 1 TiB. (That morning's totals counted BigQuery script children twice, so they are ~3% high. The per-model figures below are right; see § BigQuery spend.)
- The prod build accounted for 1.72 TiB of it (61 builds).
- `silver_ibge_pam` + `silver_ibge_pevs` were 774 GiB of that (45%).
- Superseded rows were **88.4%** of `bronze_ibge.sidra_t289_raw` (34.4 M of 38.9 M; 24.1 M from the two failed `reconcile` runs of 2026-08/09) and **70.2%** of `bronze_pam.sidra_t5457_raw` (39.7 M of 56.6 M).

**The keep rule.** Per Silver natural key — `ano, municipio_codigo, <produto>_codigo, variavel_codigo, lower(trim(unidade_de_medida))` — a row stays if either:
- it is at the key's LATEST `ingestion_timestamp`; or
- the key was REVISED by IBGE (more than one distinct `valor`) and the row is the FIRST ingestion of its value.

Only identical re-fetches go. The revision history must stay in Bronze because **the GCS raw zone does not keep it**:
- raw files are named by product/year window and overwritten by each fetch;
- the bucket deletes noncurrent object versions after 30 days.

So for anything older than a month, Bronze is the only record of what IBGE served on a given date. In PEVS, 89 keys (1,045 rows) had been revised between 2026-05-17 and 2026-09-25; in PAM, none.

**How it was proven before anything was deleted (read-only).** On each table, one query compared the full table with the kept subset:
- the row Silver picks per key: identical, fingerprint and count;
- the row `reconcile-check` picks per its coarser key: identical;
- the key count and the `(key, valor)` pair count: all preserved;
- ties at the latest ingestion: 0.

**Backup and results.**
- Backup: both tables were exported whole to `gs://embrapa-dashboard-commodities-datalake/backups/bronze-pre-poda-20260926T031526Z/`, then read back through an external table. Row count and `BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(row)))` matched the originals. Kept 365 days by the `backups/` lifecycle rule. `doctor` ignores it, since it only lists `run=` prefixes.
- Deleted: 34,423,951 rows (PEVS) and 39,747,635 (PAM), exactly the counts the proof predicted.
- Remaining: 4,504,169 rows (the 4,504,080 keys + the 89 revisions' earlier values) and 16,855,890 rows. Keys and value pairs unchanged.
- The two DELETEs billed 14.8 GB.

The DELETE (PEVS shown). For PAM, swap the table for `bronze_pam.sidra_t5457_raw` and the product column for `produto_das_lavouras_temporarias_e_permanentes_codigo`. No key column is NULL in either table, so plain equality identifies each `(key, ingestion_timestamp, valor)`, and a row's fate depends only on that triple.

```sql
DELETE FROM `embrapa-dashboard-commodities.bronze_ibge.sidra_t289_raw` AS t
WHERE EXISTS (
  SELECT 1
  FROM (
    SELECT ano, municipio_codigo, tipo_de_produto_extrativo_codigo AS produto, variavel_codigo,
      LOWER(TRIM(unidade_de_medida)) AS unidade, valor, ingestion_timestamp,
      MAX(ingestion_timestamp) OVER (PARTITION BY ano, municipio_codigo, tipo_de_produto_extrativo_codigo, variavel_codigo, LOWER(TRIM(unidade_de_medida))) AS ts_max,
      MIN(ingestion_timestamp) OVER (PARTITION BY ano, municipio_codigo, tipo_de_produto_extrativo_codigo, variavel_codigo, LOWER(TRIM(unidade_de_medida)), valor) AS ts_valor,
      COUNT(DISTINCT valor) OVER (PARTITION BY ano, municipio_codigo, tipo_de_produto_extrativo_codigo, variavel_codigo, LOWER(TRIM(unidade_de_medida))) AS n_valores
    FROM `embrapa-dashboard-commodities.bronze_ibge.sidra_t289_raw`
  ) AS s
  WHERE NOT (s.ingestion_timestamp = s.ts_max OR (s.n_valores > 1 AND s.ingestion_timestamp = s.ts_valor))
    AND s.ano = t.ano AND s.municipio_codigo = t.municipio_codigo
    AND s.produto = t.tipo_de_produto_extrativo_codigo AND s.variavel_codigo = t.variavel_codigo
    AND s.unidade = LOWER(TRIM(t.unidade_de_medida))
    AND s.ingestion_timestamp = t.ingestion_timestamp AND s.valor = t.valor
)
```

**Doing it again.**
- Copies re-accumulate with every full re-ingest, and the weekly delta adds a small overlap.
- Re-measure the superseded share first (`COUNTIF(rn = 1)` over the same key, ordered by `ingestion_timestamp DESC`). Prune only when the scan matters, and in the same order: read-only proof → verified backup → DELETE → count check.
- Don't run it while an ingestion loads the table: PEVS runs Monday 05:00 BRT, PAM runs the 2nd at 04:00.
- The `bq` CLI crashes on a DML `--dry_run` (a recursion error in its output formatting). Dry-run DML through the Python client (`QueryJobConfig(dry_run=True)`) instead.

**Restoring, if it is ever needed.**
- Within 48 h, time travel works: these datasets keep 48 h, not the default 7 days. Copy from the table as it was before the DELETE, e.g. `bq cp 'bronze_ibge.sidra_t289_raw@<epoch_ms_before>' bronze_ibge.sidra_t289_raw_restore`.
- After 48 h, load the Parquet backup into a NEW table.
- Either way, check count + fingerprint against the numbers above before swapping anything.

## BigQuery spend — `embrapa doctor` § `bq-spend`

**What the check does.** `doctor` sums the bytes the project's queries billed in the last 30 days and names the top three principals. It warns at 80% of the free 1 TiB/month and says by how much the total exceeds it. It never fails: spend is a budget question, not a broken pipeline.

**What the number is, and is not:**
- **The free tier is per BILLING ACCOUNT.** Another project on the same account shares it, so the real headroom can be smaller than the check shows.
- **The view is regional.** It covers only jobs that ran in `BQ_LOCATION`.
- **It needs `bigquery.jobs.listAll`.** An identity without that permission gets `skipped:`, not a number.
- **It costs ~20 MB per doctor run**, the minimum for that view.

**Why it exists.** A code comment said the project sat at ~15% of the free tier, measured 2026-08-28. A month later it was at 2.63 TiB, and it was found by chance.

**Measuring it yourself — count each job ONCE.** dbt's incremental models run as BigQuery scripts, and a script's parent job bills the sum of its children, which are listed too. Summing every row counts those bytes twice: 3% of the total on 2026-09-26, and parent equalled children to the byte across 425 scripts. Sum TOP-LEVEL jobs only (`parent_job_id IS NULL`). The parent is also the row that carries the dbt node id, so the same filter gives a correct per-model breakdown:

```sql
SELECT REGEXP_EXTRACT(query, r'"node_id": "([^"]+)"') AS node,
       COUNT(*) AS jobs, ROUND(SUM(total_bytes_billed) / POW(1024, 3), 2) AS gib
FROM `embrapa-dashboard-commodities`.`region-us-central1`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND job_type = 'QUERY' AND state = 'DONE' AND parent_job_id IS NULL
  AND REGEXP_CONTAINS(user_email, r'^sa-dbt-build-ci@')
GROUP BY node ORDER BY gib DESC
```

**Baseline, 2026-09-26 (30 days, counted once): 2.63 TiB.**

| Principal | Billed | Share |
|---|---|---|
| Prod build (`sa-dbt-build-ci`) | 1.65 TiB | 63% |
| Local development and audits (`igorlopesC`) | 0.68 TiB | 26% |
| The panel (`sa-web-dashboard-prod`) | 0.10 TiB | 4% |

The earlier figures in § Pruning superseded Bronze rows (2.63 TiB / 1.72 TiB, measured that morning) counted script children twice, so they are ~3% high. The per-model numbers there were counted by node and are right.

**Two levers pulled that day:**
1. **Bronze pruning** (§ above). The build right after read 18.0 GiB against ~28 GiB before (−36%); `silver_ibge_pevs` fell 5.96 → 0.77 GiB and `silver_ibge_pam` 6.99 → 2.12 GiB. Both sides of that comparison include the script children, so the ratio holds.
2. **Skipping a push-triggered build that changes nothing** (v1.97.0, `scripts/dbt_build_fingerprint.py`). In the backtest, 12 of 46 push builds would have been skipped.

**The build after both: 17.46 GiB, counted once.** Where it goes now:
- `silver_ibge_pam` 2.12 GiB;
- `silver_comtrade_flows` 2.02;
- `gold_pam_production` 1.32;
- `silver_ibge_ppm` 0.86;
- `silver_ibge_pevs` 0.77;
- the PAM uniqueness test 0.71;
- `serving_comtrade_annual` 0.66.

**Levers not pulled yet**, in the order the numbers suggest:
- the Silver `>=` boundary that makes the "incremental" models re-read every year (header of `silver_ibge_pevs.sql`);
- `silver_comtrade_flows`;
- local development, which is the second-largest consumer. Two cheap habits:
  - **Build only the touched models in dev, deferring the rest to prod:** `dbt parse --target prod --target-path <dir>` writes the prod manifest without querying anything; then `dbt build --target dev --select <models> --defer --favor-state --state <dir>` reads unselected upstream from prod instead of rebuilding it. The full dev build in `docs/testing.md` is for dbt upgrades, where every model must be compared.
  - **Run `--dry_run` before any large ad-hoc query.**

## Destructive-command safety hooks

[`scripts/claude-hooks/block-dangerous-commands.js`](../scripts/claude-hooks/block-dangerous-commands.js)
is a `PreToolUse` hook (registered in `.claude/settings.json`) that blocks
destructive command patterns before execution, at `SAFETY_LEVEL = 'high'`.
Relevant gated patterns:

- `bq rm` and `bq query … DROP {TABLE,DATASET,SCHEMA}` — BigQuery deletion
- `gcloud run services delete` — Cloud Run service deletion
- `gcloud storage rm … gs://…` / `gsutil rm` — GCS bucket/object deletion
- `gcloud projects delete`, force-push to `main`/`master`/`prod`, `rm -rf ~`,
  `dd` to a disk device, etc.

Implication: **deleting BigQuery datasets, Cloud Run services, or GCS objects is
blocked for assistants/automation in this repo and must be run manually** in your
own shell. Not gated: `gcloud run revisions delete` (only `services delete` is) —
and note it takes one revision per invocation, not a list. To lift the hook,
remove its entry from `.claude/settings.json` and restart the session.

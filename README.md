# Commission Calculator

A customizable rule-driven commission calculator with a full audit trail.

Upload deal-level data, define the rules that route each deal to its own rate
table (per deal or against a running period balance) and get a payout where
every figure is traceable.

## Files

| File | Purpose |
|---|---|
| `index.html` | All of the app |
| `test-engine.js` | Node test suite for the engine (`node test-engine.js`) |
| `sample-deals.csv` | The deal export the built-in plan loads with |
| `netlify.toml` | Netlify config (publish root, functions dir, security headers) |
| `api/agent-core.mjs` | The agent proxy — prompts, tool schema, guards |
| `worker/` | Cloudflare Worker wrapper for the proxy |
| `netlify/functions/` | Netlify Function wrapper for the proxy |
| `test-agent-ui.js` | Browser test of the agent panel against a mocked endpoint |

## Architecture

```
PLAN (JSON) + DATA (deal rows)  ->  calculate(plan, data)  ->  { results, audit[] }  ->  render
```

**PLAN and DATA are separate.** The plan holds the *logic* (rate
tables, rules, components, modifiers). The data holds the rows of specific
uploaded deal level data from the user. The agent layer (TODO) will author the plan; the user supplies the data.

`calculate()` is a **pure function**. Every number it
produces has an audit step recording the label, the formula, and
the value. 

## Deal data

A CSV where each row is one deal and the first row is column headers. Rules reference whatever headers are uploaded. Values are read tolerantly: `$1,200,000`, `1200000` 
and `(400)` (negative) all parse.

Load by drag-and-drop, local computer file picker, or pasting CSV text.

## Plan schema

```jsonc
{
  "version": 3,
  "meta":  { "planName": "...", "periodStart": "2026-01-01", "periodEnd": "2026-12-31" },
  "payee": {
    "name": "...", "id": "...",
    "startDate": "", "endDate": "",   // blank = full period
    "prorate": true,
    "targetIncentive": 40000          // variable at target; drives quota components only
  },
  "accrual":   { "sortField": "Close Date", "direction": "asc" },
  "rateTables": [ ... ],
  "rules":      [ ... ],
  "components": [ ... ],
  "modifiers":  [ ... ]
}
```

### `rateTable`

```jsonc
{
  "id": "rt-succession",
  "name": "Succession — deal value",
  "basis": "value",          // "value" | "cumulative" | "attainment"
  "mode":  "marginal",
  "tiers": [ { "from": 0, "to": 250000, "rate": 4 },
             { "from": 250000, "to": null, "rate": 5 } ],  // to: null = infinity
  "poolBy": "", "openingBalance": 0                        // cumulative only
}
```

Bands are half-open so a value landing exactly on a break belongs
to the upper band.


```jsonc
{
  "id": "r1", "name": "Succession deals", "enabled": true,
  "match": "all",                                    // "all" | "any"
  "conditions": [ { "field": "Deal Type", "op": "is", "value": "Succession" } ],
  "action": {
    "type": "rateTable",          // "rateTable" | "percent" | "fixed" | "clawback" | "exclude"
    "measureField": "Deal Value", // deal column holding the dollar amount
    "rateTableId": "rt-succession",
    "percent": 0,                 // when type = percent
    "amount": 0,                  // when type = fixed
    "uplift": 1,                  // multiplier on the measure BEFORE banding
    "upliftField": "",            // optional column multiplier; multiplies with uplift
    "creditPctField": "Credit %", // optional split column; blank cell = 100
    "clawbackRate": 0,            // when type = clawback: the rate originally paid
    "clawbackRateField": "",      // optional column holding that rate; overrides above
    "reducesBalance": false       // clawback also removes the ARR from a balance
  }
}
```

**Rules are tested top to bottom and the first match wins.** A rule with no
conditions matches every deal — keep one at the bottom as a catch-all, or
unmatched deals pay nothing (the engine warns when that happens).

Operators: `is`, `isnot`, `contains`, `notcontains`, `oneof` (comma-separated),
`gt`, `gte`, `lt`, `lte`, `between` (`"a, b"`), `blank`, `notblank`.
String comparisons are case-insensitive; numeric ones parse currency strings.

**The comparison operators understand dates.** When both sides look like dates
`YYYY-MM-DD`, or `M/D/YYYY` read US-style they compare as dates, otherwise as
numbers. For example, `Close Date gt 2026-08-31` cleanly separates fiscal months.

### Credit uplift

`uplift` scales the measure **before** it is banded. A multi-year 1.15×, a
strategic-product kicker. It changes what is credited, not the rate
applied to it, so on a cumulative table it changes what goes into the balance.

Put the condition that earns the uplift on the rule, and give that rule the
uplift. With first-match-wins ordering, a multi-year policy reads directly:

```jsonc
{ "name": "Multi-year Renewal (term > 18)",
  "conditions": [ { "field": "Deal Type", "op": "is", "value": "Renewal" },
                  { "field": "Term Months", "op": "gt", "value": "18" } ],
  "action": { "type": "rateTable", "measureField": "ARR",
              "rateTableId": "rt-ytd", "uplift": 1.15 } }
```

`measure = column × uplift × upliftField` — a blank uplift cell counts as 1, and
the constant and the column multiply together.

### Clawback

`type: "clawback"` reverses commission already paid, **at the rate it was paid
at** not at today's band, which is the whole point of a clawback.

```
commission = -( |measure| × rate% ) × credit%
```

The rate comes from `clawbackRate`, or from `clawbackRateField` when the row
carries the original rate (the engine warns if neither is set, rather than
quietly recovering $0). The measure may be positive or negative; magnitude is
what counts.

By default a clawback leaves the running balance alone, because recovering a
payment is not the same as restating year-to-date credit. Set `reducesBalance`
(with `rateTableId` naming the pool) when the plan does restate — the reversed
ARR then comes off the balance and shifts the bands for everything credited
after it.

### `component` (optional, quota-based)

```jsonc
{
  "id": "c1", "name": "Annual production",
  "weight": 100,                  // % share of payee.targetIncentive
  "quota": 2500000, "prorateQuota": true,
  "actualSource": "sum",          // "manual" | "sum"
  "actualField": "Deal Value",    // when "sum": totals this column across deal rows
  "actual": 0,                    // when "manual"
  "payout": { "rateTableId": "rt-quota", "thresholdPct": 0, "capPct": 250 }
}
```

### `modifier`

```jsonc
{
  "id": "m1", "name": "Adherence rating",
  "appliesTo": "all",             // "all" | "deals" | "quota"
  "selected": 1,                  // index into options
  "options": [ { "label": "5 — Excellent", "factor": 1 },
               { "label": "4 — Good", "factor": 0.9 } ]
}
```

## Order of operations

1. Days on plan ÷ days in period → proration factor
2. Match every deal row to the first rule that accepts it
3. Sort by `accrual`, then credit each row:
   - `measure = column × uplift` — the uplift lands before any banding
   - per-deal actions → commission × credit %
   - cumulative tables → credited measure = measure × credit %, accrued into the
     pool balance; the band(s) follow from that balance
   - clawbacks → negative commission at the rate originally paid
   - then re-rate any `retro` pool at its final band
4. Deal commission subtotal
5. Quota components: target × weight; actual ÷ prorated quota → attainment;
   threshold → attainment rate table → cap → dollars
6. Quota commission subtotal
7. Modifiers, in array order, against their scope
8. Total variable earnings

Deal commission is **never prorated**, it is earned per deal. Proration
affects the target incentive and quotas only.

Note the two places credit % applies differently: on a per-deal rule the band comes
from the full deal size and the split is applied to the payout; on a cumulative
table the split reduces the volume that accrues, because the credited amount *is*
the thing being banded.

## Outputs

- **Cumulative pools** — each running balance: volume credited, ending balance,
  final band reached, and the band-by-band breakdown of what it paid. Retro pools
  also show what as-accrued would have paid and the size of the true-up
- **Commission statement** — one line per rule and per component, then modifiers
- **Audit trail** — numbered steps with the formula and values behind each figure;
  "Copy audit" exports it as Markdown
- **Deal detail** — every row with the rule it matched, the calculation applied,
  the credit split and the commission; "Copy as CSV" exports it

The engine warns on: unmatched deals, component weights ≠ 100%, rate tables
referenced but missing, columns referenced but absent from the uploaded data,
production without a quota, a clawback with no rate set, and a negative amount on
a normal rule (which cumulative bands cannot pay — use a clawback instead).

`calculate()` also returns `pools[]` (each with `volume`, `balance`, `finalTier`,
`bands[]` and, for retro, `retro.asAccrued`) and `accrualOrder` — the row indices
in the order they were credited.

## The agent layer

Section 03 takes a plan document in plain English and proposes the rate tables
and rules for it. Nothing is applied until you review a diff, and
`validatePlan()` gates what may be applied at all.

**The model writes configuration, never a payout.** It proposes rate tables and
rules; the deterministic engine still computes every figure, and the audit trail
still shows its work. That boundary is why the plan and the data were kept as
separate objects from the start.

Two modes:

- **Draft** — plan document plus your CSV's column names in, proposed rate tables
  and rules out, with `notes` (every judgement call it made) and `unsupported`
  (plan terms the schema cannot express, stated rather than approximated).
- **Verify** — the document, the resulting configuration and the audit trail go
  back, and it reports findings: wrong threshold boundaries, per-deal tiering
  where the document means period-to-date, missing exclusions or clawbacks,
  rules ordered so an earlier one swallows a later one.

### Why there is a server at all

The API key must never reach the browser. This page is static — anyone can open
View Source — so the key lives in the server environment and the page calls a
proxy that holds it.

```
  index.html                 /api/draft-plan              Anthropic
  no key at all       ──▶   agent-core.mjs        ──▶   api.anthropic.com
                            ANTHROPIC_API_KEY
                            PASSPHRASE
```

### Deploying on Netlify (same origin)

`netlify/functions/draft-plan.mjs` serves the proxy at `/api/draft-plan` on the
site's own origin, so the page needs no configuration — leave the endpoint field
blank and it calls itself. No CORS is involved.

1. Commit `api/` and `netlify/` — they are new directories, so `git add` them
   explicitly. A deploy without them leaves `/api/draft-plan` returning 404,
   which the page now says in as many words.
2. In **Site configuration → Environment variables**, set:
   - `ANTHROPIC_API_KEY` — from console.anthropic.com
   - `PASSPHRASE` — anything; the page asks for it
   - `ALLOWED_ORIGIN` — the site URL, optional but worth setting
3. Redeploy.

**Set `PASSPHRASE` before the site is public.** Without it the proxy answers
anyone who finds the URL, and every call spends your API credits.

### Deploying the proxy elsewhere (GitHub Pages, or any static host)

When the page and the proxy live apart, deploy `worker/` to Cloudflare Workers:

```bash
cd worker
npx wrangler deploy
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put PASSPHRASE
```

Then click **Endpoint** in section 03 and paste the `*.workers.dev` URL. Set
`ALLOWED_ORIGIN` in `wrangler.toml` to the page's origin. Both wrappers call the
same `api/agent-core.mjs`; only the few lines around it differ.

### Guards

The proxy refuses anything without the passphrase, caps the document at 60,000
characters and the body at 400KB, rejects non-POST methods, and answers CORS
preflight. It returns token usage so you can see what each call cost. A draft on
a 4,000-character document runs roughly 6k input / 2k output tokens. Check
current pricing before assuming a figure.

### If you would rather not run a server

The alternative is browser-direct calls, where each user pastes their **own** key
and the request carries `anthropic-dangerous-direct-browser-access: true`. The
header is named as a warning. It works and costs you nothing, but every visitor
needs their own key — a poor fit for anything you hand to someone else. Not
implemented here.

## Testing

```
node test-engine.js
```

248 assertions: CSV parsing (quoted commas, escaped quotes, currency, duplicate
headers); hand-computed payouts for all three per-deal shapes and all three
cumulative shapes; accrual ordering (ascending, descending, numeric, date, file
order) and its effect on both attribution and totals; pool scoping via `poolBy`;
opening balances; credit splits; band-boundary behaviour; date-aware comparison
operators; credit uplift as a constant, a column, and both; clawbacks at a
constant rate, a column rate, with and without balance restatement; rule ordering
and enablement; all twelve condition operators; `all` vs `any`; modifier scoping;
proration; thresholds and caps; missing-column detection; audit-trail integrity;
and a full end-to-end regression of the shipped plan, deal by deal. The plan the
app previously shipped with is kept in the test file as a fixture, so per-deal
rate-table shapes, quota components and modifiers stay covered.

`node test-agent-ui.js` runs 41 more against a mocked endpoint, covering the
agent panel end to end: settings persistence, the draft round-trip, validation
blocking a bad draft, applying a draft and watching the engine recalculate from
it, verify mode, and the failure paths.

## Roadmap

- [x] Site shell and design system
- [x] Deal-level CSV upload with column detection
- [x] Reusable rate tables (deal-value, cumulative and attainment bases, three shapes each)
- [x] Period-cumulative tiering — running balances, pool scoping, carry-in, retro true-up
- [x] Date-aware condition operators (fiscal-month cutoffs)
- [x] Credit uplift — measure adjustments before banding (multi-year, kickers, haircuts)
- [x] Clawbacks — reversal at the rate originally paid, optional balance restatement
- [x] Custom rule builder — conditions, first-match-wins ordering, four action types
- [x] Quota components fed by deal data
- [x] Audit trail and line-level deal detail
- [x] Plan JSON import/export + schema reference for the agent
- [ ] Multi-payee batch (one CSV, many reps)
- [ ] Saved scenarios and side-by-side comparison
- [ ] **Agent layer** — Netlify Function calling an LLM that reads a plan document
      in plain English, emits the plan JSON above, runs `calculate()`, and
      validates the audit trail against the written plan terms

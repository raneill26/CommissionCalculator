# Commission Calculator

A single-file, rule-driven commission calculator with a full audit trail.
Upload deal-level data, define the rules that route each deal to its own rate
table — per deal or against a running period balance — and get a payout where
every figure is traceable. No build step, no
dependencies — drop `index.html` on Netlify and it runs.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app: markup, styles, engine, UI |
| `test-engine.js` | Node test suite for the engine (`node test-engine.js`) |
| `sample-deals.csv` | Example deal file matching the built-in sample plan |
| `netlify.toml` | Netlify config (publish root, functions dir, security headers) |

## Deploying

Drag this folder onto https://app.netlify.com/drop, or connect it as a Git repo.
Publish directory is the project root.

## Architecture

```
PLAN (JSON) + DATA (deal rows)  ->  calculate(plan, data)  ->  { results, audit[] }  ->  render
```

**PLAN and DATA are deliberately separate.** The plan holds the *logic* — rate
tables, rules, components, modifiers. The data holds the deal rows the user
uploads. The agent layer will author the plan; the user supplies the data.

`calculate()` is a **pure function**: no DOM, no globals. Every number it
produces is accompanied by an audit step recording the label, the formula, and
the value. That contract is the whole point — it means an LLM can emit a plan,
run the engine, and verify the trace without touching the UI.

Exposed on `window.CommissionEngine`:

```js
CommissionEngine.calculate(plan, data)  // -> { variable, dealGross, quotaGross, detail, audit, warnings, ... }
CommissionEngine.defaultPlan()          // -> the sample plan
CommissionEngine.csvToData(text, name)  // -> { name, columns, rows }
CommissionEngine.getPlan() / setPlan(p)
CommissionEngine.getData() / setData(d)
```

## Deal data

A CSV where each row is one deal and the first row is column headers. Column
names are free — rules reference whatever headers you upload. Values are read
tolerantly: `$1,200,000`, `1200000` and `(400)` (negative) all parse.

Load by drag-and-drop, file picker, or pasting CSV text.

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

Bands are half-open — `[from, to)` — so a value landing exactly on a break belongs
to the upper band.

**`basis: "value"` — one deal at a time.** The band is set by that deal's own size.

| mode | Result |
|---|---|
| `marginal` | `Σ (dollars of the deal inside a band × rate%)` |
| `cliff` | `deal value × rate%` of the band it lands in |
| `flat` | flat dollar amount of the band it lands in |

**`basis: "cumulative"` — a running balance across the period.** Each deal accrues
its *credited* measure into a pool; the band depends on the balance standing at that
moment, so `plan.accrual` decides the sequence.

| mode | Result |
|---|---|
| `marginal` | each dollar of the balance earns its band's rate; a deal straddling a break is split across bands |
| `retro` | the band reached at period end re-rates **all** of the period's volume (a true-up) |
| `wholeDeal` | each deal pays entirely at the band the balance sat in *before* it was credited |

`poolBy` keeps a separate balance per value of that column (per product line, per
territory). `openingBalance` carries credit in from a prior period — it sets the
starting band, and under `retro` it is not re-paid.

Worked example — three $20,000 deals against $15,000 bands at 2 / 4 / 6 / 8%:

| | deal 1 | deal 2 | deal 3 | total |
|---|---|---|---|---|
| `marginal` | $500 | $1,000 | $1,500 | **$3,000** |
| `retro` | $1,600 | $1,600 | $1,600 | **$4,800** |
| `wholeDeal` | $400 | $800 | $1,200 | **$2,400** |

Under `marginal` the total is order-independent within a pool, but the
per-deal attribution is not. Under `wholeDeal` and `retro` the order changes
the total too.

**`basis: "attainment"` — percent of quota.** Used by quota components.

| mode | Result |
|---|---|
| `marginal` | `Σ (attainment points in tier × rate)` → payout % |
| `cliff` | `attainment × multiplier` of the tier it lands in → payout % |
| `flat` | fixed share of target for that tier → payout % |

### `accrual`

```jsonc
"accrual": { "sortField": "Close Date", "direction": "asc" }
```

The order deals are credited in. Only cumulative tables depend on it, but it is
applied consistently so the audit is reproducible. A blank `sortField` keeps file
order. Numeric columns compare numerically; everything else compares as text, which
sorts ISO dates correctly.

### `rule`

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

**The comparison operators understand dates.** When both sides look like dates —
`YYYY-MM-DD`, or `M/D/YYYY` read US-style — they compare as dates; otherwise as
numbers. So `Close Date gt 2026-08-31` cleanly separates fiscal months. (Before
this, `2026-08-12` parsed as the number `2026` and every date in a year compared
equal, which silently misclassified deals.)

### Credit uplift

`uplift` scales the measure **before** it is banded — a multi-year 1.15×, a
strategic-product kicker, a haircut. It changes what is credited, not the rate
applied to it, so on a cumulative table it changes what accrues into the balance.

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
at** — not at today's band, which is the whole point of a clawback.

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

Deal commission is **never prorated** — it is earned per deal. Proration
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

## Testing

```
node test-engine.js
```

195 assertions: CSV parsing (quoted commas, escaped quotes, currency, duplicate
headers); hand-computed payouts for all three per-deal shapes and all three
cumulative shapes; accrual ordering (ascending, descending, numeric, date, file
order) and its effect on both attribution and totals; pool scoping via `poolBy`;
opening balances; credit splits; band-boundary behaviour; date-aware comparison
operators; credit uplift as a constant, a column, and both; clawbacks at a
constant rate, a column rate, with and without balance restatement; rule ordering
and enablement; all twelve condition operators; `all` vs `any`; modifier scoping;
proration; thresholds and caps; missing-column detection; audit-trail integrity;
and one end-to-end regression of a full monthly close — multi-year uplift,
fiscal-month cutoff, overlay split, PS exclusion, YTD carry-in across a
four-band curve, and a clawback.

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

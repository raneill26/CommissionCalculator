# Commission Calculator

A single-file, rule-driven commission calculator with a full audit trail.
Upload deal-level data, define the rules that route each deal to its own rate
table, and get a payout where every figure is traceable. No build step, no
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
  "version": 2,
  "meta":  { "planName": "...", "periodStart": "2026-01-01", "periodEnd": "2026-12-31" },
  "payee": {
    "name": "...", "id": "...",
    "startDate": "", "endDate": "",   // blank = full period
    "prorate": true,
    "targetIncentive": 40000          // variable at target; drives quota components only
  },
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
  "basis": "value",          // "value" (per deal) | "attainment" (percent of quota)
  "mode":  "marginal",       // "marginal" | "cliff" | "flat"
  "tiers": [ { "from": 0, "to": 250000, "rate": 4 },
             { "from": 250000, "to": null, "rate": 5 } ]   // to: null = infinity
}
```

| basis | mode | Result |
|---|---|---|
| `value` | `marginal` | `Σ (dollars of the deal inside a band × rate%)` |
| `value` | `cliff` | `deal value × rate%` of the band it lands in |
| `value` | `flat` | flat dollar amount of the band it lands in |
| `attainment` | `marginal` | `Σ (attainment points in tier × rate)` → payout % |
| `attainment` | `cliff` | `attainment × multiplier` of the tier it lands in → payout % |
| `attainment` | `flat` | fixed share of target for that tier → payout % |

### `rule`

```jsonc
{
  "id": "r1", "name": "Succession deals", "enabled": true,
  "match": "all",                                    // "all" | "any"
  "conditions": [ { "field": "Deal Type", "op": "is", "value": "Succession" } ],
  "action": {
    "type": "rateTable",          // "rateTable" | "percent" | "fixed" | "exclude"
    "measureField": "Deal Value", // deal column holding the dollar amount
    "rateTableId": "rt-succession",
    "percent": 0,                 // when type = percent
    "amount": 0,                  // when type = fixed
    "creditPctField": "Credit %"  // optional split column; blank cell = 100
  }
}
```

**Rules are tested top to bottom and the first match wins.** A rule with no
conditions matches every deal — keep one at the bottom as a catch-all, or
unmatched deals pay nothing (the engine warns when that happens).

Operators: `is`, `isnot`, `contains`, `notcontains`, `oneof` (comma-separated),
`gt`, `gte`, `lt`, `lte`, `between` (`"a, b"`), `blank`, `notblank`.
String comparisons are case-insensitive; numeric ones parse currency strings.

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
2. Each deal row → first matching rule → action → × credit %
3. Deal commission subtotal
4. Quota components: target × weight; actual ÷ prorated quota → attainment;
   threshold → attainment rate table → cap → dollars
5. Quota commission subtotal
6. Modifiers, in array order, against their scope
7. Total variable earnings

Deal commission is **never prorated** — it is earned per deal. Proration
affects the target incentive and quotas only.

## Outputs

- **Commission statement** — one line per rule and per component, then modifiers
- **Audit trail** — numbered steps with the formula and values behind each figure;
  "Copy audit" exports it as Markdown
- **Deal detail** — every row with the rule it matched, the calculation applied,
  the credit split and the commission; "Copy as CSV" exports it

The engine warns on: unmatched deals, component weights ≠ 100%, rate tables
referenced but missing, columns referenced but absent from the uploaded data,
and production without a quota.

## Testing

```
node test-engine.js
```

89 assertions: CSV parsing (quoted commas, escaped quotes, currency, duplicate
headers), hand-computed per-deal payouts for all three rate-table shapes, credit
splits, exclusions, rule ordering and enablement, all twelve condition
operators, `all` vs `any` matching, modifier scoping, proration, thresholds and
caps, missing-column detection, and audit-trail integrity.

## Roadmap

- [x] Site shell and design system
- [x] Deal-level CSV upload with column detection
- [x] Reusable rate tables (deal-value and attainment bases, three shapes each)
- [x] Custom rule builder — conditions, first-match-wins ordering, four action types
- [x] Quota components fed by deal data
- [x] Audit trail and line-level deal detail
- [x] Plan JSON import/export + schema reference for the agent
- [ ] Multi-payee batch (one CSV, many reps)
- [ ] Saved scenarios and side-by-side comparison
- [ ] **Agent layer** — Netlify Function calling an LLM that reads a plan document
      in plain English, emits the plan JSON above, runs `calculate()`, and
      validates the audit trail against the written plan terms

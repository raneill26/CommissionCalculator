# Commission Calculator

A single-file, configurable sales commission calculator with a full audit trail.
No build step, no dependencies — drop `index.html` on Netlify and it runs.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app: markup, styles, engine, UI |
| `test-engine.js` | Node test suite for the calculation engine (`node test-engine.js`) |
| `netlify.toml` | Netlify config (publish root, security headers) |

## Deploying

Drag this folder onto https://app.netlify.com/drop, or connect it as a Git repo.
Publish directory is the project root.

## Architecture

```
PLAN (JSON)  ->  calculate(plan)  ->  { results, audit[] }  ->  render
```

`calculate()` is a **pure function**. It reads a plan object, returns results, and
never touches the DOM. Every number it produces is accompanied by an audit step
recording the label, the formula, and the value. That contract is deliberate: the
agent layer can build a plan, call the engine, and verify the trace without the UI.

The engine is exposed on `window.CommissionEngine`:

```js
CommissionEngine.calculate(plan)   // -> { variable, total, components, audit, warnings, ... }
CommissionEngine.defaultPlan()     // -> the sample plan
CommissionEngine.getPlan()         // -> current plan in the UI
CommissionEngine.setPlan(plan)     // -> load a plan and re-render
```

## Plan schema

```jsonc
{
  "version": 1,
  "meta": { "planName": "FY26 AE Plan", "periodStart": "2026-01-01", "periodEnd": "2026-12-31" },
  "payee": {
    "name": "Jordan Blake",
    "id": "EMP-1042",
    "baseSalary": 80000,
    "startDate": "",              // blank = start of period
    "endDate": "",                // blank = end of period
    "prorate": true,              // prorate target & quota by days on plan
    "targetIncentive": { "mode": "percent", "value": 20 }   // or mode "amount"
  },
  "components": [{
    "id": "c1",
    "name": "New business ARR",
    "weight": 70,                 // % of target incentive; all components should total 100
    "quota": 600000,
    "actual": 510000,
    "prorateQuota": true,
    "payout": {
      "mode": "marginal",         // "marginal" | "cliff" | "flat"
      "thresholdPct": 0,          // below this attainment the component pays 0
      "capPct": 250,              // max payout as % of component target; null = uncapped
      "tiers": [
        { "from": 0,   "to": 100,  "rate": 1 },
        { "from": 100, "to": 150,  "rate": 1.5 },
        { "from": 150, "to": null, "rate": 2 }    // to: null = infinity
      ]
    }
  }],
  "modifiers": [{
    "id": "m1",
    "name": "Adherence rating",
    "selected": 1,                // index into options
    "options": [
      { "label": "5 — Excellent", "factor": 1 },
      { "label": "4 — Good", "factor": 0.9 }
    ]
  }]
}
```

### Payout modes

| Mode | Meaning | Payout % formula |
|---|---|---|
| `marginal` | Each attainment point inside a tier earns that tier's rate. Only points above a threshold get the higher rate. | `Σ (points in tier × tier rate)` |
| `cliff` | Crossing a tier changes the multiplier on the **entire** payout. | `attainment × multiplier of containing tier` |
| `flat` | Landing anywhere in a tier pays a fixed share of target. | `tier rate × 100` |

Payout dollars are always `component target × payout % ÷ 100`, where
`component target = prorated target incentive × weight%`.

### Calculation order

1. Days in period, days on plan, proration factor
2. Target incentive → prorated target incentive
3. Per component: component target → prorated quota → attainment → threshold check
   → tier math → cap → payout dollars
4. Subtotal of components
5. Modifiers applied in array order, each multiplying the running total
6. Total variable earnings; total comp = prorated base + variable

## Testing

```
node test-engine.js
```

40 assertions covering hand-computed payouts, proration, all three tier modes,
thresholds, caps, weight and zero-quota guards, and audit-trail integrity.

## Roadmap

- [x] Site shell and design system
- [x] Configurable plan builder (components, tiers, modifiers)
- [x] Calculation engine with step-by-step audit trail
- [x] Plan JSON import/export
- [ ] Multi-payee / batch upload (CSV of actuals against one plan)
- [ ] Save named scenarios and compare side by side
- [ ] Earnings curve chart across 0–200% attainment
- [ ] **Agent layer** — Netlify Function calling an LLM that reads a plan document
      in plain English, emits the plan JSON, runs `calculate()`, and validates the
      audit trail against the written plan terms

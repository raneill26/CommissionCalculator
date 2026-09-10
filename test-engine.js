/* Engine test harness: slices the DOM-free part of index.html and runs cases. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const engineSrc = script.split('/* ------------------------------ 4. RENDER')[0];
const mod = { exports: {} };
new Function('module', engineSrc + '\nmodule.exports={calculate,defaultPlan,findTier};')(mod);
const { calculate, defaultPlan } = mod.exports;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
function check(name, actual, expected) {
  const ok = typeof expected === 'number' ? near(actual, expected) : actual === expected;
  if (ok) { pass++; console.log('  PASS  ' + name + '  = ' + actual); }
  else { fail++; console.log('  FAIL  ' + name + '  expected ' + expected + ', got ' + actual); }
}

/* ---- 1. default plan, hand-computed --------------------------------- */
console.log('\n1. Default plan (full year, no proration)');
let r = calculate(defaultPlan());
check('period days', r.periodDays, 365);
check('proration', r.proration, 1);
check('target incentive', r.targetIncentive, 16000);
check('c1 attainment %', r.components[0].attainment, 85);
check('c1 payout % (marginal 85x1)', r.components[0].payoutPct, 85);
check('c1 payout $ (11200x.85)', r.components[0].payout, 9520);
check('c2 attainment %', r.components[1].attainment, 98);
check('c2 payout % (cliff 98x1.0)', r.components[1].payoutPct, 98);
check('c2 payout $ (4800x.98)', r.components[1].payout, 4704);
check('subtotal', r.subtotal, 14224);
check('variable after 0.9 adherence', r.variable, 12801.6);
check('total comp', r.total, 92801.6);
check('no warnings', r.warnings.length, 0);

/* ---- 2. proration --------------------------------------------------- */
console.log('\n2. Mid-year start 2026-07-01 (184 of 365 days)');
let p = defaultPlan(); p.payee.startDate = '2026-07-01';
r = calculate(p);
check('days on plan', r.daysOnPlan, 184);
check('proration', r.proration, 184 / 365);
check('prorated target', r.proratedTarget, 16000 * 184 / 365);
check('c1 prorated quota', r.components[0].proratedQuota, 600000 * 184 / 365);
check('c1 attainment unchanged by scaling', r.components[0].attainment, 510000 / (600000 * 184 / 365) * 100);
check('prorated base', r.proratedBase, 80000 * 184 / 365);

/* ---- 3. marginal tiers above quota ---------------------------------- */
console.log('\n3. Marginal build-up at 120% and 180%');
p = defaultPlan();
p.components[0].actual = 720000;            // 120%
r = calculate(p);
check('120%: 100x1 + 20x1.5 = 130', r.components[0].payoutPct, 130);
p.components[0].actual = 1080000;           // 180%
r = calculate(p);
check('180%: 100 + 50x1.5 + 30x2 = 235', r.components[0].payoutPct, 235);

/* ---- 4. cap --------------------------------------------------------- */
console.log('\n4. Cap at 250%');
p = defaultPlan();
p.components[0].actual = 1500000;           // 250% -> 100+75+150 = 325 raw
r = calculate(p);
check('raw 325 capped to 250', r.components[0].payoutPct, 250);
check('capped flag', r.components[0].capped, true);

/* ---- 5. threshold --------------------------------------------------- */
console.log('\n5. Threshold on renewals (60% minimum)');
p = defaultPlan();
p.components[1].actual = 200000;            // 50% attainment
r = calculate(p);
check('attainment', r.components[1].attainment, 50);
check('below threshold pays 0', r.components[1].payout, 0);
check('hitThreshold false', r.components[1].hitThreshold, false);

/* ---- 6. cliff multiplier tiers -------------------------------------- */
console.log('\n6. Cliff multipliers');
p = defaultPlan();
p.components[1].actual = 480000;            // 120% -> tier 100-125 @1.2
r = calculate(p);
check('120% x 1.2 = 144', r.components[1].payoutPct, 144);
p.components[1].actual = 600000;            // 150% -> tier 125+ @1.35
r = calculate(p);
check('150% x 1.35 = 202.5', r.components[1].payoutPct, 202.5);

/* ---- 7. flat step --------------------------------------------------- */
console.log('\n7. Flat step mode');
p = defaultPlan();
p.components[0].payout = { mode: 'flat', thresholdPct: 0, capPct: null,
  tiers: [{ from: 0, to: 80, rate: 0 }, { from: 80, to: 100, rate: 0.5 }, { from: 100, to: null, rate: 1 }] };
p.components[0].actual = 510000;            // 85% -> tier 80-100 -> 0.5
r = calculate(p);
check('85% lands in 80-100 -> 50%', r.components[0].payoutPct, 50);
check('payout $ = 11200 x .5', r.components[0].payout, 5600);

/* ---- 8. guards ------------------------------------------------------ */
console.log('\n8. Guards');
p = defaultPlan();
p.components[0].quota = 0;
r = calculate(p);
check('zero quota -> 0% attainment', r.components[0].attainment, 0);
check('warns about zero quota', r.warnings.length > 0, true);

p = defaultPlan();
p.components[0].weight = 60;                // totals 90
r = calculate(p);
check('warns on weight total', r.warnings.some(w => w.includes('weights total')), true);

p = defaultPlan();
p.payee.prorate = false; p.payee.startDate = '2026-07-01';
r = calculate(p);
check('proration disabled -> 1', r.proration, 1);

p = defaultPlan();
p.payee.targetIncentive = { mode: 'amount', value: 25000 };
r = calculate(p);
check('direct amount target', r.targetIncentive, 25000);

p = defaultPlan(); p.components = []; p.modifiers = [];
r = calculate(p);
check('empty plan variable', r.variable, 0);
check('empty plan total = base', r.total, 80000);

/* ---- 9. audit integrity --------------------------------------------- */
console.log('\n9. Audit trail');
r = calculate(defaultPlan());
const steps = r.audit.filter(s => !s.group);
check('every step has a formula', steps.every(s => s.formula && s.display), true);
check('steps numbered sequentially', steps.every((s, i) => s.n === i + 1), true);
const last = steps[steps.length - 1];
check('final audit value = total', last.value, r.total);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

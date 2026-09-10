/* Engine tests. Slices the DOM-free part of index.html and runs it in node. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const engineSrc = script.split('/* ------------------------------ 4. RENDER')[0];
const mod = { exports: {} };
new Function('module', engineSrc +
  '\nmodule.exports={calculate,defaultPlan,csvToData,parseCSV,SAMPLE_CSV,applyValueTable,ruleMatches,testCondition,num};')(mod);
const { calculate, defaultPlan, csvToData, parseCSV, SAMPLE_CSV, applyValueTable, testCondition, num } = mod.exports;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
function check(name, actual, expected) {
  const ok = typeof expected === 'number' ? near(actual, expected) : actual === expected;
  if (ok) { pass++; console.log('  PASS  ' + name + '  = ' + actual); }
  else { fail++; console.log('  FAIL  ' + name + '  expected ' + expected + ', got ' + actual); }
}
const sample = () => csvToData(SAMPLE_CSV, 'sample-deals.csv');

/* ---- 1. CSV parsing -------------------------------------------------- */
console.log('\n1. CSV parsing');
let d = sample();
check('columns', d.columns.length, 6);
check('rows', d.rows.length, 8);
check('first deal id', d.rows[0]['Deal ID'], 'D-1001');
check('deal value read as text', d.rows[0]['Deal Value'], '310000');

const quoted = csvToData('A,B\n"Smith, John","said ""hi"""\nplain,2', 'q.csv');
check('quoted comma kept', quoted.rows[0].A, 'Smith, John');
check('escaped quotes', quoted.rows[0].B, 'said "hi"');
check('blank lines dropped', quoted.rows.length, 2);
check('currency string -> number', num('$1,250.50'), 1250.5);
check('parenthesised negative', num('(400)'), -400);
check('duplicate headers disambiguated', csvToData('A,A\n1,2').columns.join('|'), 'A|A (2)');

/* ---- 2. deal rules, hand-computed ------------------------------------ */
console.log('\n2. Sample plan — deal-by-deal (hand-computed)');
let r = calculate(defaultPlan(), sample());
const byDeal = {};
r.detail.forEach(x => { byDeal[x.row['Deal ID']] = x; });

check('D-1001 succession marginal 250k@4 + 60k@5', byDeal['D-1001'].commission, 13000);
check('D-1002 transition cliff 185k x 3%', byDeal['D-1002'].commission, 5550);
check('D-1003 full build flat 9000 x 50% credit', byDeal['D-1003'].commission, 4500);
check('D-1004 succession 240k @4%', byDeal['D-1004'].commission, 9600);
check('D-1005 transition cliff 415k x 4%', byDeal['D-1005'].commission, 16600);
check('D-1006 full build flat 5000', byDeal['D-1006'].commission, 5000);
check('D-1007 succession 10000+12500+3600', byDeal['D-1007'].commission, 26100);
check('D-1008 referral catch-all 2% of 95k', byDeal['D-1008'].commission, 1900);
check('deal total (before modifiers)', r.dealGross, 82250);
check('no unmatched deals', r.unmatched, 0);

/* ---- 3. quota side --------------------------------------------------- */
console.log('\n3. Quota component (actual summed from deal data)');
check('actual = sum of Deal Value', r.components[0].actual, 2490000);
check('attainment 2.49M / 2.5M', r.components[0].attainment, 99.6);
check('marginal curve pays 99.6%', r.components[0].payoutPct, 99.6);
check('quota payout 40000 x 99.6%', r.quotaGross, 39840);

/* ---- 4. modifiers & total -------------------------------------------- */
console.log('\n4. Modifier and total');
check('subtotal', r.subtotal, 122090);
check('total after 0.9 adherence', r.variable, 109881);
check('no warnings', r.warnings.length, 0);

/* ---- 5. modifier scoping --------------------------------------------- */
console.log('\n5. Modifier scope');
let p = defaultPlan(); p.modifiers[0].appliesTo = 'quota';
r = calculate(p, sample());
check('deal side untouched', r.dealTotal, 82250);
check('quota side x0.9', r.quotaTotal, 39840 * 0.9);
check('total', r.variable, 82250 + 39840 * 0.9);

p = defaultPlan(); p.modifiers[0].appliesTo = 'deals';
r = calculate(p, sample());
check('deal side x0.9', r.dealTotal, 82250 * 0.9);
check('quota side untouched', r.quotaTotal, 39840);
check('gross is reported unmodified', r.dealGross, 82250);
check('gross + gross = subtotal', r.dealGross + r.quotaGross, r.subtotal);

/* ---- 6. rule ordering, first match wins ------------------------------ */
console.log('\n6. Rule ordering and enablement');
p = defaultPlan();
p.rules.unshift({ id: 'r0', name: 'Cap everything', enabled: true, match: 'all', conditions: [],
  action: { type: 'fixed', measureField: 'Deal Value', amount: 100, percent: 0, rateTableId: '', creditPctField: '' } });
r = calculate(p, sample());
check('catch-all first swallows all deals', r.dealGross, 800);

p = defaultPlan(); p.rules[0].enabled = false;      // disable Succession
r = calculate(p, sample());
check('disabled rule falls through to 2% catch-all',
  r.detail.find(x => x.row['Deal ID'] === 'D-1001').commission, 310000 * 0.02);

p = defaultPlan(); p.rules.pop();                    // remove catch-all
r = calculate(p, sample());
check('referral now unmatched', r.unmatched, 1);
check('unmatched pays nothing', r.dealGross, 82250 - 1900);
check('warns about unmatched', r.warnings.some(w => w.includes('matched no rule')), true);

/* ---- 7. condition operators ------------------------------------------ */
console.log('\n7. Condition operators');
const row = { Type: 'Full Build', Value: '250000', Rep: '', Note: 'Q3 renewal' };
const t = (op, field, value) => testCondition(row, { field, op, value });
check('is (case-insensitive)', t('is', 'Type', 'full build'), true);
check('isnot', t('isnot', 'Type', 'Succession'), true);
check('contains', t('contains', 'Note', 'renew'), true);
check('notcontains', t('notcontains', 'Note', 'churn'), true);
check('oneof', t('oneof', 'Type', 'Succession, Full Build'), true);
check('oneof miss', t('oneof', 'Type', 'Succession, Transition'), false);
check('gt', t('gt', 'Value', '200000'), true);
check('gte boundary', t('gte', 'Value', '250000'), true);
check('lt', t('lt', 'Value', '250000'), false);
check('lte boundary', t('lte', 'Value', '250000'), true);
check('between inclusive', t('between', 'Value', '200000, 300000'), true);
check('between outside', t('between', 'Value', '300000, 400000'), false);
check('blank', t('blank', 'Rep', ''), true);
check('notblank', t('notblank', 'Type', ''), true);

console.log('\n   match: all vs any');
p = defaultPlan();
p.rules[0].conditions = [{ field: 'Deal Type', op: 'is', value: 'Succession' },
                         { field: 'Deal Value', op: 'gte', value: '500000' }];
r = calculate(p, sample());
check('AND narrows to 1 deal', r.byRule[0].count, 1);
p.rules[0].match = 'any';
r = calculate(p, sample());
check('OR widens to 3 deals', r.byRule[0].count, 3);

/* ---- 8. rate table shapes -------------------------------------------- */
console.log('\n8. Rate table shapes');
const marg = { mode: 'marginal', tiers: [{ from: 0, to: 100000, rate: 2 }, { from: 100000, to: null, rate: 5 }] };
check('marginal 80k', applyValueTable(marg, 80000).amount, 1600);
check('marginal 300k = 2000 + 10000', applyValueTable(marg, 300000).amount, 12000);
const cliff = { mode: 'cliff', tiers: [{ from: 0, to: 100000, rate: 2 }, { from: 100000, to: null, rate: 5 }] };
check('cliff 300k = whole x 5%', applyValueTable(cliff, 300000).amount, 15000);
check('cliff boundary 100k uses upper band', applyValueTable(cliff, 100000).amount, 5000);
const flat = { mode: 'flat', tiers: [{ from: 0, to: 100000, rate: 1000 }, { from: 100000, to: null, rate: 4000 }] };
check('flat below break', applyValueTable(flat, 50000).amount, 1000);
check('flat above break', applyValueTable(flat, 900000).amount, 4000);
check('missing table pays 0', applyValueTable(null, 500000).amount, 0);

/* ---- 9. credit % / exclude ------------------------------------------- */
console.log('\n9. Credit split and exclusions');
p = defaultPlan();
let dd = sample(); dd.rows[0]['Credit %'] = '25';
r = calculate(p, dd);
check('25% credit on 13000', r.detail[0].commission, 3250);
dd = sample(); dd.rows[0]['Credit %'] = '';
r = calculate(p, dd);
check('blank credit treated as 100%', r.detail[0].commission, 13000);

p = defaultPlan();
p.rules[0].action = { type: 'exclude', measureField: 'Deal Value', creditPctField: '' };
r = calculate(p, sample());
check('excluded deals pay 0', r.detail.filter(x => x.row['Deal Type'] === 'Succession')
  .every(x => x.commission === 0), true);
check('excluded removed from total', r.dealGross, 82250 - 13000 - 9600 - 26100);

/* ---- 10. proration --------------------------------------------------- */
console.log('\n10. Proration (deal commission is never prorated)');
p = defaultPlan(); p.payee.startDate = '2026-07-01';
r = calculate(p, sample());
check('days on plan', r.daysOnPlan, 184);
check('proration', r.proration, 184 / 365);
check('deal commission unaffected', r.dealGross, 82250);
check('prorated target', r.proratedTarget, 40000 * 184 / 365);
check('prorated quota drives higher attainment',
  r.components[0].attainment, 2490000 / (2500000 * 184 / 365) * 100);
check('cap holds payout at 250%', r.components[0].payoutPct, 250);

p.payee.prorate = false;
r = calculate(p, sample());
check('proration off -> factor 1', r.proration, 1);

/* ---- 11. thresholds and empty states --------------------------------- */
console.log('\n11. Thresholds and empty states');
p = defaultPlan(); p.components[0].payout.thresholdPct = 100;
r = calculate(p, sample());
check('99.6% below 100% threshold pays 0', r.quotaTotal, 0);

p = defaultPlan(); p.components = [];
r = calculate(p, sample());
check('no components -> deals only', r.variable, 82250 * 0.9);

p = defaultPlan(); p.rules = [];
r = calculate(p, sample());
check('no rules -> every deal unmatched', r.unmatched, 8);
check('deal total 0', r.dealGross, 0);

r = calculate(defaultPlan(), { columns: [], rows: [] });
check('no deal data -> quota only', r.dealGross, 0);
check('manual-source component still needs data', r.components[0].actual, 0);

p = defaultPlan(); p.components[0].actualSource = 'manual'; p.components[0].actual = 2500000;
r = calculate(p, { columns: [], rows: [] });
check('manual actual at 100% pays full target', r.quotaGross, 40000);

/* ---- 11b. missing column detection ------------------------------------ */
console.log('\n11b. Missing column detection');
const alt = csvToData('Opportunity,Segment,Booking Amount\nOPP-1,Enterprise,1200000', 'alt.csv');
r = calculate(defaultPlan(), alt);
check('warns when referenced columns are absent',
  r.warnings.some(w => w.includes('not found in the loaded data')), true);
check('names the missing measure column', r.warnings.some(w => w.includes('"Deal Value"')), true);
check('missing columns measure zero', r.dealGross, 0);
check('no false alarm on the sample', calculate(defaultPlan(), sample()).warnings.length, 0);

/* ---- 12. audit integrity --------------------------------------------- */
console.log('\n12. Audit trail');
r = calculate(defaultPlan(), sample());
const steps = r.audit.filter(s => !s.group);
check('every step carries a formula', steps.every(s => s.formula && s.display), true);
check('numbered sequentially', steps.every((s, i) => s.n === i + 1), true);
check('final step equals total', steps[steps.length - 1].value, r.variable);
check('detail rows match deal count', r.detail.length, 8);
check('detail sums to deal total before modifiers',
  r.detail.reduce((s, x) => s + x.commission, 0), 82250);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

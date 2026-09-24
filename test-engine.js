/* Engine tests. Slices the DOM-free part of index.html and runs it in node. */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const engineSrc = script.split('/* ------------------------------ 4. RENDER')[0];
const mod = { exports: {} };
new Function('module', engineSrc +
  '\nmodule.exports={calculate,defaultPlan,csvToData,parseCSV,SAMPLE_CSV,applyValueTable,walkBands,ruleMatches,testCondition,num};')(mod);
const { calculate, defaultPlan, csvToData, SAMPLE_CSV, applyValueTable, walkBands, testCondition, num } = mod.exports;

/* The plan the app used to ship as its default. Kept here as a fixture so
   per-deal rate-table shapes (marginal / cliff / flat), quota components and
   modifiers stay covered now that the shipped default is the FY26 AE plan. */
function mdvipPlan() {
  return {
    version: 3,
    meta: { planName: 'FY26 Practice Development Plan', periodStart: '2026-01-01', periodEnd: '2026-12-31' },
    payee: { name: 'Walter White', id: 'EMP-1042', startDate: '', endDate: '', prorate: true, targetIncentive: 40000 },

    /* Order deals are credited in. Only matters for cumulative rate tables,
       where the band a deal earns depends on the balance before it. */
    accrual: { sortField: 'Close Date', direction: 'asc' },

    rateTables: [
      { id: 'rt-succession', name: 'Succession — deal value', basis: 'value', mode: 'marginal',
        tiers: [ { from: 0, to: 250000, rate: 4 }, { from: 250000, to: 500000, rate: 5 }, { from: 500000, to: null, rate: 6 } ] },
      { id: 'rt-transition', name: 'Transition — deal value', basis: 'value', mode: 'cliff',
        tiers: [ { from: 0, to: 200000, rate: 3 }, { from: 200000, to: 400000, rate: 3.5 }, { from: 400000, to: null, rate: 4 } ] },
      { id: 'rt-fullbuild', name: 'Full Build — flat per deal', basis: 'value', mode: 'flat',
        tiers: [ { from: 0, to: 300000, rate: 5000 }, { from: 300000, to: null, rate: 9000 } ] },
      { id: 'rt-acv', name: 'ACV credit — cumulative', basis: 'cumulative', mode: 'marginal',
        poolBy: '', openingBalance: 0,
        tiers: [ { from: 0, to: 15000, rate: 2 }, { from: 15000, to: 30000, rate: 4 },
                 { from: 30000, to: 45000, rate: 6 }, { from: 45000, to: null, rate: 8 } ] },
      { id: 'rt-quota', name: 'Standard quota curve', basis: 'attainment', mode: 'marginal',
        tiers: [ { from: 0, to: 100, rate: 1 }, { from: 100, to: 150, rate: 1.5 }, { from: 150, to: null, rate: 2 } ] }
    ],

    rules: [
      { id: 'r1', name: 'Succession deals', enabled: true, match: 'all',
        conditions: [ { field: 'Deal Type', op: 'is', value: 'Succession' } ],
        action: { type: 'rateTable', measureField: 'Deal Value', rateTableId: 'rt-succession', percent: 0, amount: 0, creditPctField: 'Credit %' } },
      { id: 'r2', name: 'Transition deals', enabled: true, match: 'all',
        conditions: [ { field: 'Deal Type', op: 'is', value: 'Transition' } ],
        action: { type: 'rateTable', measureField: 'Deal Value', rateTableId: 'rt-transition', percent: 0, amount: 0, creditPctField: 'Credit %' } },
      { id: 'r3', name: 'Full Build deals', enabled: true, match: 'all',
        conditions: [ { field: 'Deal Type', op: 'is', value: 'Full Build' } ],
        action: { type: 'rateTable', measureField: 'Deal Value', rateTableId: 'rt-fullbuild', percent: 0, amount: 0, creditPctField: 'Credit %' } },
      { id: 'r4', name: 'Everything else — cumulative ACV', enabled: true, match: 'all',
        conditions: [],
        action: { type: 'rateTable', measureField: 'Deal Value', rateTableId: 'rt-acv', percent: 0, amount: 0, creditPctField: 'Credit %' } }
    ],

    components: [
      { id: 'c1', name: 'Annual production', weight: 100, quota: 2500000,
        actualSource: 'sum', actualField: 'Deal Value', actual: 0, prorateQuota: true,
        payout: { rateTableId: 'rt-quota', thresholdPct: 0, capPct: 250 } }
    ],

    modifiers: [
      { id: 'm1', name: 'Adherence rating', appliesTo: 'all', selected: 1,
        options: [
          { label: '5 — Excellent', factor: 1 },
          { label: '4 — Good', factor: 0.9 },
          { label: '3 — Satisfactory', factor: 0.75 },
          { label: '2 — Needs improvement', factor: 0.5 },
          { label: '1 — Unsatisfactory', factor: 0.25 }
        ] }
    ]
  };
}

const MDVIP_CSV =
`Deal ID,Practice,Deal Type,Close Date,Deal Value,Credit %
D-1001,Harborview Family Medicine,Succession,2026-02-14,310000,100
D-1002,Cedar Park Internal Medicine,Transition,2026-03-02,185000,100
D-1003,Lakeshore Primary Care,Full Build,2026-03-27,420000,50
D-1004,Northgate Medical Group,Succession,2026-05-11,240000,100
D-1005,Ridgeline Health Partners,Transition,2026-06-08,415000,100
D-1006,Summit Family Care,Full Build,2026-07-19,265000,100
D-1007,Baywood Clinic,Succession,2026-09-01,560000,100
D-1008,Elmwood Associates,Referral,2026-09-22,20000,100
D-1009,Fairhaven Physicians,Referral,2026-10-06,20000,100
D-1010,Oakmont Medical,Referral,2026-11-03,20000,100
D-1011,Willow Creek Family,Referral,2026-11-20,12000,50`;

let pass = 0, fail = 0;
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
function check(name, actual, expected) {
  const ok = typeof expected === 'number' ? near(actual, expected) : actual === expected;
  if (ok) { pass++; console.log('  PASS  ' + name + '  = ' + actual); }
  else { fail++; console.log('  FAIL  ' + name + '  expected ' + expected + ', got ' + actual); }
}
const sample = () => csvToData(MDVIP_CSV, 'mdvip-deals.csv');
const byId = r => { const o = {}; r.detail.forEach(x => { o[x.row['Deal ID']] = x; }); return o; };

/* Isolated cumulative fixture: $15,000 bands at 2 / 4 / 6 / 8 percent. */
const BANDS = [{ from: 0, to: 15000, rate: 2 }, { from: 15000, to: 30000, rate: 4 },
               { from: 30000, to: 45000, rate: 6 }, { from: 45000, to: null, rate: 8 }];
function cumPlan(mode, opts) {
  opts = opts || {};
  const p = mdvipPlan();
  p.components = []; p.modifiers = [];
  p.rateTables = [{ id: 'rt', name: 'ACV', basis: 'cumulative', mode,
                    poolBy: opts.poolBy || '', openingBalance: opts.opening || 0, tiers: BANDS }];
  p.rules = [{ id: 'r', name: 'All', enabled: true, match: 'all', conditions: [],
               action: { type: 'rateTable', measureField: 'ACV', rateTableId: 'rt', creditPctField: 'Credit %' } }];
  p.accrual = { sortField: 'sortField' in opts ? opts.sortField : 'Seq', direction: opts.direction || 'asc' };
  return p;
}
const equalDeals   = () => csvToData('Seq,Type,ACV,Credit %\n1,A,20000,100\n2,B,20000,100\n3,A,20000,100', 't.csv');
const unequalDeals = () => csvToData('Seq,Type,ACV,Credit %\n1,A,10000,100\n2,A,30000,100\n3,A,20000,100', 'u.csv');

/* ---- 1. CSV parsing -------------------------------------------------- */
console.log('\n1. CSV parsing');
let d = sample();
check('columns', d.columns.length, 6);
check('rows', d.rows.length, 11);
check('first deal id', d.rows[0]['Deal ID'], 'D-1001');
check('deal value read as text', d.rows[0]['Deal Value'], '310000');

const quoted = csvToData('A,B\n"Smith, John","said ""hi"""\nplain,2', 'q.csv');
check('quoted comma kept', quoted.rows[0].A, 'Smith, John');
check('escaped quotes', quoted.rows[0].B, 'said "hi"');
check('blank lines dropped', quoted.rows.length, 2);
check('currency string -> number', num('$1,250.50'), 1250.5);
check('parenthesised negative', num('(400)'), -400);
check('duplicate headers disambiguated', csvToData('A,A\n1,2').columns.join('|'), 'A|A (2)');

/* ---- 2. per-deal rules, hand-computed -------------------------------- */
console.log('\n2. Sample plan — per-deal rules');
let r = calculate(mdvipPlan(), sample());
let D = byId(r);
check('D-1001 succession marginal 250k@4 + 60k@5', D['D-1001'].commission, 13000);
check('D-1002 transition cliff 185k x 3%', D['D-1002'].commission, 5550);
check('D-1003 full build flat 9000 x 50% credit', D['D-1003'].commission, 4500);
check('D-1004 succession 240k @4%', D['D-1004'].commission, 9600);
check('D-1005 transition cliff 415k x 4%', D['D-1005'].commission, 16600);
check('D-1006 full build flat 5000', D['D-1006'].commission, 5000);
check('D-1007 succession 10000+12500+3600', D['D-1007'].commission, 26100);

/* ---- 3. cumulative pool in the sample -------------------------------- */
console.log('\n3. Sample plan — cumulative ACV pool ($15k bands, 2/4/6/8%)');
check('D-1008 balance 0->20k: 15k@2 + 5k@4', D['D-1008'].commission, 500);
check('D-1009 balance 20k->40k: 10k@4 + 10k@6', D['D-1009'].commission, 1000);
check('D-1010 balance 40k->60k: 5k@6 + 15k@8', D['D-1010'].commission, 1500);
check('D-1011 12k at 50% credit accrues 6k @8%', D['D-1011'].commission, 480);
let pool = r.pools[0];
check('one pool', r.pools.length, 1);
check('pool volume', pool.volume, 66000);
check('pool ending balance', pool.balance, 66000);
check('final band reached', pool.finalTier, '$45,000+');
check('pool commission', pool.commission, 3480);
check('bands sum to pool commission',
  pool.bands.reduce((s, b) => s + b.commission, 0), pool.commission);
check('band volumes sum to pool volume',
  pool.bands.reduce((s, b) => s + b.volume, 0), pool.volume);
check('deal total = per-deal 80350 + pool 3480', r.dealGross, 83830);

/* ---- 4. quota, modifiers, total -------------------------------------- */
console.log('\n4. Quota side and total');
check('actual = sum of Deal Value', r.components[0].actual, 2467000);
check('attainment 2.467M / 2.5M', r.components[0].attainment, 98.68);
check('quota payout 40000 x 98.68%', r.quotaGross, 39472);
check('subtotal', r.subtotal, 123302);
check('total after 0.9 adherence', r.variable, 110971.8);
check('no warnings', r.warnings.length, 0);

/* ---- 5. the headline case: three $20k deals, $15k bands -------------- */
console.log('\n5. Three $20,000 deals against $15,000 bands');
r = calculate(cumPlan('marginal'), equalDeals());
let items = r.detail.map(x => x.commission);
check('deal 1 starts in tier 1', items[0], 500);      // 15k@2 + 5k@4
check('deal 2 spans tiers 2-3',  items[1], 1000);     // 10k@4 + 10k@6
check('deal 3 ends in tier 4',   items[2], 1500);     // 5k@6 + 15k@8
check('total marginal', r.dealGross, 3000);
check('ends in the top band', r.pools[0].finalTier, '$45,000+');
check('blended rate on $60k', r.dealGross / 60000 * 100, 5);

console.log('\n   same deals, retroactive re-rate');
r = calculate(cumPlan('retro'), equalDeals());
check('every deal re-rated at 8%', r.detail.every(x => near(x.commission, 1600)), true);
check('total retro = 60000 x 8%', r.dealGross, 4800);
check('reports what as-accrued would have paid', r.pools[0].retro.asAccrued, 3000);
check('true-up amount', r.pools[0].commission - r.pools[0].retro.asAccrued, 1800);
check('final band named', r.pools[0].retro.tier, '$45,000+');

console.log('\n   same deals, whole deal at the tier you were in');
r = calculate(cumPlan('wholeDeal'), equalDeals());
items = r.detail.map(x => x.commission);
check('deal 1 at 2% (balance was 0)',      items[0], 400);
check('deal 2 at 4% (balance was 20k)',    items[1], 800);
check('deal 3 at 6% (balance was 40k)',    items[2], 1200);
check('total whole-deal', r.dealGross, 2400);
check('no band splitting', r.pools[0].items.every(it => it.parts.length === 1), true);

/* ---- 6. accrual order ------------------------------------------------ */
console.log('\n6. Accrual order');
r = calculate(cumPlan('marginal', { direction: 'desc' }), equalDeals());
check('desc credits row 3 first', r.accrualOrder.join(','), '2,1,0');
check('row 3 now earns the first-band amount', r.detail[2].commission, 500);
check('row 1 now earns the top-band amount', r.detail[0].commission, 1500);
check('marginal total is order-independent', r.dealGross, 3000);
check('detail stays in original row order',
  r.detail.map(x => x.row.Seq).join(','), '1,2,3');

r = calculate(cumPlan('wholeDeal'), unequalDeals());
check('whole-deal asc: 10k@2 + 30k@2 + 20k@6', r.dealGross, 200 + 600 + 1200);
r = calculate(cumPlan('wholeDeal', { direction: 'desc' }), unequalDeals());
check('whole-deal desc: 20k@2 + 30k@4 + 10k@8', r.dealGross, 400 + 1200 + 800);

r = calculate(cumPlan('marginal', { sortField: 'ACV' }), unequalDeals());
check('numeric column sorts numerically, not as text',
  r.accrualOrder.join(','), '0,2,1');
r = calculate(cumPlan('marginal', { sortField: '' }), unequalDeals());
check('blank sort field keeps file order', r.accrualOrder.join(','), '0,1,2');

/* ---- 7. pools, opening balances, credit splits ----------------------- */
console.log('\n7. Pool scoping, carry-in and splits');
r = calculate(cumPlan('marginal', { poolBy: 'Type' }), equalDeals());
check('poolBy splits into two balances', r.pools.length, 2);
const pA = r.pools.find(p => p.poolByValue === 'A'), pB = r.pools.find(p => p.poolByValue === 'B');
check('pool A holds two deals', pA.items.length, 2);
check('pool A balance', pA.balance, 40000);
check('pool A commission 500 + 1000', pA.commission, 1500);
check('pool B is its own balance', pB.balance, 20000);
check('pool B commission', pB.commission, 500);
check('total across pools', r.dealGross, 2000);

r = calculate(cumPlan('marginal', { opening: 30000 }), equalDeals());
check('opening balance starts in band 3', r.detail[0].commission, 900 + 400);
check('ending balance includes carry-in', r.pools[0].balance, 90000);
check('volume excludes carry-in', r.pools[0].volume, 60000);
check('total with carry-in', r.dealGross, 1300 + 1600 + 1600);

r = calculate(cumPlan('retro', { opening: 40000 }), equalDeals());
check('retro pays only this period volume', r.dealGross, 60000 * 0.08);

let half = csvToData('Seq,Type,ACV,Credit %\n1,A,20000,50\n2,A,20000,100', 'h.csv');
r = calculate(cumPlan('marginal'), half);
check('50% credit accrues half the ACV', r.pools[0].volume, 30000);
check('deal 1 credited 10000 -> all in band 1', r.detail[0].commission, 200);
check('deal 2 credited 20000 from 10000', r.detail[1].commission, 100 + 600);

/* ---- 8. cumulative edge cases ---------------------------------------- */
console.log('\n8. Cumulative edge cases');
r = calculate(cumPlan('marginal'), csvToData('Seq,Type,ACV,Credit %\n1,A,15000,100', 'e.csv'));
check('deal landing exactly on a break stays in band 1', r.dealGross, 300);
r = calculate(cumPlan('wholeDeal'), csvToData('Seq,Type,ACV,Credit %\n1,A,15000,100\n2,A,1,100', 'e.csv'));
check('next deal at balance 15000 uses band 2', r.detail[1].commission, 0.04);
r = calculate(cumPlan('marginal'), csvToData('Seq,Type,ACV,Credit %\n1,A,0,100', 'z.csv'));
check('zero-value deal earns nothing', r.dealGross, 0);
check('but still counts as accrued', r.pools[0].items.length, 1);
r = calculate(cumPlan('marginal'), csvToData('Seq,Type,ACV,Credit %\n1,A,500000,100', 'b.csv'));
check('one huge deal walks every band', r.dealGross, 300 + 600 + 900 + 455000 * 0.08);
check('all four bands engaged', r.pools[0].bands.length, 4);

let noTiers = cumPlan('marginal'); noTiers.rateTables[0].tiers = [];
r = calculate(noTiers, equalDeals());
check('table with no bands pays nothing', r.dealGross, 0);

/* ---- 9. modifier scoping --------------------------------------------- */
console.log('\n9. Modifier scope');
let p = mdvipPlan(); p.modifiers[0].appliesTo = 'quota';
r = calculate(p, sample());
check('deal side untouched', r.dealTotal, 83830);
check('quota side x0.9', r.quotaTotal, 39472 * 0.9);

p = mdvipPlan(); p.modifiers[0].appliesTo = 'deals';
r = calculate(p, sample());
check('deal side x0.9', r.dealTotal, 83830 * 0.9);
check('quota side untouched', r.quotaTotal, 39472);
check('gross reported unmodified', r.dealGross, 83830);
check('gross + gross = subtotal', r.dealGross + r.quotaGross, r.subtotal);

/* ---- 10. rule ordering and enablement -------------------------------- */
console.log('\n10. Rule ordering and enablement');
p = mdvipPlan();
p.rules.unshift({ id: 'r0', name: 'Flat everything', enabled: true, match: 'all', conditions: [],
  action: { type: 'fixed', measureField: 'Deal Value', amount: 100, percent: 0, rateTableId: '', creditPctField: '' } });
r = calculate(p, sample());
check('catch-all first swallows all 11 deals', r.dealGross, 1100);
check('cumulative pool never forms', r.pools.length, 0);

p = mdvipPlan();
p.rules[0].enabled = false;                                   // disable Succession
p.rules[3].action = { type: 'percent', measureField: 'Deal Value', percent: 2, creditPctField: 'Credit %' };
r = calculate(p, sample());
check('disabled rule falls through to the catch-all',
  byId(r)['D-1001'].commission, 310000 * 0.02);

p = mdvipPlan(); p.rules.pop();                             // remove catch-all
r = calculate(p, sample());
check('four referral deals now unmatched', r.unmatched, 4);
check('unmatched pay nothing', r.dealGross, 80350);
check('warns about unmatched', r.warnings.some(w => w.includes('matched no rule')), true);

/* ---- 11. condition operators ----------------------------------------- */
console.log('\n11. Condition operators');
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

p = mdvipPlan();
p.rules[0].conditions = [{ field: 'Deal Type', op: 'is', value: 'Succession' },
                         { field: 'Deal Value', op: 'gte', value: '500000' }];
r = calculate(p, sample());
check('AND narrows to 1 deal', r.byRule[0].count, 1);
p.rules[0].match = 'any';
r = calculate(p, sample());
check('OR widens to 3 deals', r.byRule[0].count, 3);

/* ---- 12. per-deal rate table shapes ---------------------------------- */
console.log('\n12. Per-deal rate table shapes');
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
check('walkBands is order-agnostic over a split range',
  walkBands(BANDS, 0, 20000).total, walkBands(BANDS, 0, 15000).total + walkBands(BANDS, 15000, 20000).total);

/* ---- 13. credit split and exclusions --------------------------------- */
console.log('\n13. Credit split and exclusions');
let dd = sample(); dd.rows[0]['Credit %'] = '25';
r = calculate(mdvipPlan(), dd);
check('25% credit on a per-deal rule', r.detail[0].commission, 3250);
dd = sample(); dd.rows[0]['Credit %'] = '';
r = calculate(mdvipPlan(), dd);
check('blank credit treated as 100%', r.detail[0].commission, 13000);

p = mdvipPlan();
p.rules[0].action = { type: 'exclude', measureField: 'Deal Value', creditPctField: '' };
r = calculate(p, sample());
check('excluded deals pay 0',
  r.detail.filter(x => x.row['Deal Type'] === 'Succession').every(x => x.commission === 0), true);
check('excluded removed from total', r.dealGross, 83830 - 13000 - 9600 - 26100);

/* ---- 14. proration --------------------------------------------------- */
console.log('\n14. Proration');
p = mdvipPlan(); p.payee.startDate = '2026-07-01';
r = calculate(p, sample());
check('days on plan', r.daysOnPlan, 184);
check('proration', r.proration, 184 / 365);
check('deal commission is never prorated', r.dealGross, 83830);
check('prorated target', r.proratedTarget, 40000 * 184 / 365);
check('prorated quota lifts attainment', r.components[0].attainment, 2467000 / (2500000 * 184 / 365) * 100);
check('cap holds payout at 250%', r.components[0].payoutPct, 250);
p.payee.prorate = false;
r = calculate(p, sample());
check('proration off -> factor 1', r.proration, 1);

/* ---- 15. thresholds, empty states, missing columns ------------------- */
console.log('\n15. Thresholds, empty states, missing columns');
p = mdvipPlan(); p.components[0].payout.thresholdPct = 100;
r = calculate(p, sample());
check('98.68% below 100% threshold pays 0', r.quotaGross, 0);

p = mdvipPlan(); p.components = [];
r = calculate(p, sample());
check('no components -> deals only', r.variable, 83830 * 0.9);

p = mdvipPlan(); p.rules = [];
r = calculate(p, sample());
check('no rules -> every deal unmatched', r.unmatched, 11);
check('deal total 0', r.dealGross, 0);
check('no pools form', r.pools.length, 0);

r = calculate(mdvipPlan(), { columns: [], rows: [] });
check('no deal data -> quota only', r.dealGross, 0);
check('summed component reads 0', r.components[0].actual, 0);

p = mdvipPlan(); p.components[0].actualSource = 'manual'; p.components[0].actual = 2500000;
r = calculate(p, { columns: [], rows: [] });
check('manual actual at 100% pays full target', r.quotaGross, 40000);

const alt = csvToData('Opportunity,Segment,Booking Amount\nOPP-1,Enterprise,1200000', 'alt.csv');
r = calculate(mdvipPlan(), alt);
check('warns when referenced columns are absent',
  r.warnings.some(w => w.includes('not found in the loaded data')), true);
check('names the missing measure column', r.warnings.some(w => w.includes('"Deal Value"')), true);
check('missing columns measure zero', r.dealGross, 0);

/* ---- 16. audit integrity --------------------------------------------- */
console.log('\n16. Audit trail');
r = calculate(mdvipPlan(), sample());
const steps = r.audit.filter(s => !s.group);
check('every step carries a formula', steps.every(s => s.formula && s.display), true);
check('numbered sequentially', steps.every((s, i) => s.n === i + 1), true);
check('final step equals total', steps[steps.length - 1].value, r.variable);
check('detail rows match deal count', r.detail.length, 11);
check('detail sums to deal gross', r.detail.reduce((s, x) => s + x.commission, 0), 83830);
check('audit records the accrual order',
  steps.some(s => s.label === 'Accrual order' && s.formula.includes('Close Date')), true);
check('audit names each cumulative band',
  r.pools[0].bands.every(b => steps.some(s => s.label.includes('band ' + b.label))), true);
check('pool total appears in the audit',
  steps.some(s => s.label.includes('pool total') && near(s.value, 3480)), true);

/* ---- 17. date-aware comparisons -------------------------------------- */
console.log('\n17. Date-aware comparisons');
const aug = { d: '2026-08-12', us: '8/12/2026', n: '250000' };
const td = (op, field, value) => testCondition(aug, { field, op, value });
check('ISO date lt a later date', td('lt', 'd', '2026-09-01'), true);
check('ISO date gt an earlier date', td('gt', 'd', '2026-07-31'), true);
check('August is NOT >= 2026-09-01', td('gte', 'd', '2026-09-01'), false);
check('August IS <= 2026-08-31', td('lte', 'd', '2026-08-31'), true);
check('date between month bounds', td('between', 'd', '2026-08-01, 2026-08-31'), true);
check('date outside month bounds', td('between', 'd', '2026-09-01, 2026-09-30'), false);
check('US-style M/D/YYYY compares too', td('lt', 'us', '9/1/2026'), true);
check('numbers still compare as numbers', td('gt', 'n', '200000'), true);
check('date vs non-date falls back to numeric',
  testCondition({ d: '2026-08-12' }, { field: 'd', op: 'gt', value: 'abc' }), true);

p = mdvipPlan();
p.rules[0].conditions = [{ field: 'Close Date', op: 'gt', value: '2026-08-31' }];
r = calculate(p, sample());
check('date filter selects exactly the post-August deals (incl. Sep 1)', r.byRule[0].count, 5);
p.rules[0].conditions = [{ field: 'Close Date', op: 'between', value: '2026-08-01, 2026-08-31' }];
r = calculate(p, sample());
check('no sample deal closed in August', r.byRule[0].count, 0);

/* ---- 18. credit uplift ------------------------------------------------ */
console.log('\n18. Credit uplift');
const upRows = csvToData('Seq,Type,ACV,Credit %,Mult\n1,A,20000,100,\n2,A,20000,50,2', 'up.csv');
p = cumPlan('marginal'); p.rules[0].action.uplift = 1.15;
r = calculate(p, upRows);
check('uplift scales what accrues', r.pools[0].items[0].credited, 23000);
check('uplift shows in the audit note', r.detail[0].note.includes('1.15 uplift'), true);
check('uplift then credit % on the same row', r.pools[0].items[1].credited, 20000 * 1.15 * 0.5);

p = cumPlan('marginal'); p.rules[0].action.upliftField = 'Mult';
r = calculate(p, upRows);
check('blank uplift cell counts as 1', r.pools[0].items[0].credited, 20000);
check('uplift column applies', r.pools[0].items[1].credited, 20000 * 2 * 0.5);
p.rules[0].action.uplift = 1.5;
r = calculate(p, upRows);
check('constant and column multiply together', r.pools[0].items[1].credited, 20000 * 1.5 * 2 * 0.5);

p = mdvipPlan();
p.rules[0].action.uplift = 2;                       // Succession deals doubled
r = calculate(p, sample());
check('uplift on a per-deal marginal table rebands the deal',
  byId(r)['D-1004'].commission, 250000 * 0.04 + 230000 * 0.05);
p = mdvipPlan(); p.rules[3].action = { type: 'percent', measureField: 'Deal Value', percent: 10, uplift: 0.5, creditPctField: '' };
r = calculate(p, sample());
check('uplift works on a percent action', byId(r)['D-1008'].commission, 20000 * 0.5 * 0.10);

/* ---- 19. clawback ---------------------------------------------------- */
console.log('\n19. Clawback');
const cbRows = csvToData('Seq,Type,ACV,Credit %,Paid Rate\n1,Deal,100000,100,\n2,CB,40000,100,10', 'cb.csv');
function cbPlan(extra) {
  const q = cumPlan('marginal', { opening: 650000 });
  q.rateTables[0].tiers = [{ from: 0, to: 1000000, rate: 10 }, { from: 1000000, to: null, rate: 15 }];
  q.rules = [
    { id: 'cb', name: 'Clawback', enabled: true, match: 'all',
      conditions: [{ field: 'Type', op: 'is', value: 'CB' }],
      action: Object.assign({ type: 'clawback', measureField: 'ACV', clawbackRateField: 'Paid Rate',
                              clawbackRate: 0, creditPctField: 'Credit %' }, extra || {}) },
    { id: 'd', name: 'Deals', enabled: true, match: 'all', conditions: [],
      action: { type: 'rateTable', measureField: 'ACV', rateTableId: 'rt', creditPctField: 'Credit %' } }];
  return q;
}
r = calculate(cbPlan(), cbRows);
check('clawback is negative', r.detail[1].commission, -4000);
check('at the rate from the column, not the current band', r.detail[1].note.includes('@ 10%'), true);
check('deal side still pays normally', r.detail[0].commission, 10000);
check('net of clawback', r.dealGross, 6000);
check('balance untouched by default', r.pools[0].balance, 750000);
check('flagged as a clawback row', r.detail[1].clawback, true);

r = calculate(cbPlan({ clawbackRateField: '', clawbackRate: 15 }), cbRows);
check('constant rate when no column', r.detail[1].commission, -6000);

r = calculate(cbPlan({ reducesBalance: true, rateTableId: 'rt' }), cbRows);
check('reducesBalance restates YTD', r.pools[0].balance, 710000);
check('reduction recorded', r.pools[0].reductions, 40000);
check('commission still from the paid rate', r.detail[1].commission, -4000);

r = calculate(cbPlan({ clawbackRateField: '', clawbackRate: 0 }), cbRows);
check('warns when no clawback rate is set',
  r.warnings.some(w => w.includes('no rate set')), true);

const cbSplit = csvToData('Seq,Type,ACV,Credit %,Paid Rate\n1,CB,40000,50,10', 'cbs.csv');
r = calculate(cbPlan(), cbSplit);
check('credit % applies to a clawback too', r.detail[0].commission, -2000);
const cbNeg = csvToData('Seq,Type,ACV,Credit %,Paid Rate\n1,CB,-40000,100,10', 'cbn.csv');
r = calculate(cbPlan(), cbNeg);
check('a negative amount reverses the same way', r.detail[0].commission, -4000);

const negDeal = csvToData('Seq,Type,ACV,Credit %\n1,Deal,-40000,100', 'nd.csv');
r = calculate(cumPlan('marginal'), negDeal);
check('a negative row on a normal rule warns instead of silently paying 0',
  r.warnings.some(w => w.includes('negative amount')), true);

/* ---- 20. the SHIPPED default plan, end to end ------------------------ */
console.log('\n20. Shipped default — FY26 AE, August 2026 close');
r = calculate(defaultPlan(), csvToData(SAMPLE_CSV, 'sample-deals.csv'));
const E = {}; r.detail.forEach(x => { E[x.row['Opp ID']] = x; });

console.log('   Part A — creditable ARR by deal');
check('24-month New Business is NOT multi-year (policy needs > 24)', E['OPP-10412'].uplift, 1);
check('  credits 180,000 unchanged', E['OPP-10412'].measure, 180000);
check('12-month Expansion is not multi-year', E['OPP-10419'].uplift, 1);
check('PS fees excluded — measures Software ARR, not TCV', E['OPP-10423'].measure, 120000);
check('  TCV on the row is 140,000', num(E['OPP-10423'].row['TCV']), 140000);
check('12-month Renewal is not multi-year', E['OPP-10430'].uplift, 1);
check('24-month Renewal IS multi-year (policy needs > 18)', E['OPP-10437'].uplift, 1.15);
check('  1.15x uplift credits 230,000', E['OPP-10437'].measure, 230000);
check('overlay split credits 60%', E['OPP-10441'].measure * E['OPP-10441'].credit / 100, 96000);
check('Sept 3 close excluded from the August period', E['OPP-10455'].excluded, true);
check('total creditable ARR', r.pools[0].volume, 871000);

console.log('   Part B — YTD attainment and gross commission');
check('prior YTD carried in', r.pools[0].opening, 650000);
check('YTD creditable ARR', r.pools[0].balance, 1521000);
check('YTD attainment 152.1%', r.pools[0].balance / 1000000 * 100, 152.1);
check('band 500k-1M at 10%', r.pools[0].bands.find(b => b.rate === 10).commission, 35000);
check('band 1M-1.5M at 15%', r.pools[0].bands.find(b => b.rate === 15).commission, 75000);
check('band above 1.5M at 20%', r.pools[0].bands.find(b => b.rate === 20).commission, 4200);
check('decelerator band stays inert above 50%',
  r.pools[0].bands.some(b => b.rate === 0), false);
check('August gross commission', r.pools[0].commission, 114200);

console.log('   Part C — clawback and net payout');
check('clawback at the 1.0x rate originally paid', E['OPP-09981'].commission, -4000);
check('clawback leaves YTD credit unrestated', r.pools[0].balance, 1521000);
check('clawback records the rate it recovered at', E['OPP-09981'].rateUsed, 10);
check('NET AUGUST PAYOUT', r.dealGross, 110200);
check('no quota component double-counts the curve', r.quotaGross, 0);
check('variable equals the deal side', r.variable, 110200);
check('no warnings', r.warnings.length, 0);

console.log('   plan wiring');
check('every rule points at a table that exists',
  defaultPlan().rules.every(x => x.action.type !== 'rateTable' ||
    defaultPlan().rateTables.some(rt => rt.id === x.action.rateTableId)), true);
check('a catch-all sits at the bottom',
  (defaultPlan().rules[defaultPlan().rules.length - 1].conditions || []).length, 0);
check('every deal matched a rule', r.unmatched, 0);
check('detail covers every row', r.detail.length, 8);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);

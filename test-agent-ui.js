/* Exercises the agent panel against a mocked endpoint: draft -> validate ->
   apply -> recalculate -> verify, plus the failure paths. */
const { chromium } = require('playwright');
const fs = require('fs');

const engSrc = fs.readFileSync('index.html','utf8').split('<script>')[1].split('/* ------------------------------ 4. RENDER')[0];
const m={exports:{}}; new Function('module', engSrc+'\nmodule.exports={defaultPlan};')(m);
const dp = m.exports.defaultPlan();

/* what a well-behaved model would return for the shipped plan */
const DRAFT = {
  planName: 'FY26 AE (Rancher 2) — Commercial · August 2026',
  accrual: dp.accrual,
  rateTables: dp.rateTables,
  rules: dp.rules,
  components: [],
  notes: ['Read "greater than 24 months" as excluding 24 exactly.',
          'Decelerator modelled as a 0% band below 50% of quota.'],
  unsupported: []
};
const BAD_DRAFT = JSON.parse(JSON.stringify(DRAFT));
BAD_DRAFT.rules[2].action.rateTableId = 'rt-does-not-exist';
BAD_DRAFT.unsupported = ['SPIFF table on page 4 has no equivalent.'];

const VERIFY = {
  verdict: 'discrepancies', summary: 'One boundary is wrong.',
  findings: [{ severity:'error', area:'Multi-year New Business',
               detail:'Configured as term > 24 but the document says 24 or more.',
               quote:'contract term is GREATER THAN 24 months' },
             { severity:'note', area:'Decelerator', detail:'Inert this period.' }]
};

let pass=0, fail=0;
const check=(n,a,e)=>{ const ok=a===e; ok?pass++:fail++; console.log((ok?'  PASS  ':'  FAIL  ')+n+'  = '+a+(ok?'':'  (expected '+e+')')); };

(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' });
  const p = await b.newPage({ viewport:{width:1440,height:1000} });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  /* deliberate HTTP failures in test 7 log to the console; they are the
     point of that test, not a page fault */
  p.on('console',c=>{ if(c.type()==='error' && !/Failed to load resource/.test(c.text())) errs.push(c.text()); });

  let mock = { status:200, body:{ mode:'draft', result:DRAFT, usage:{input_tokens:5000,output_tokens:1800}, model:'claude-sonnet-5' } };
  let lastRequest = null;
  await p.route('https://mock.endpoint/**', async route => {
    lastRequest = { headers: route.request().headers(), body: JSON.parse(route.request().postData()||'{}') };
    await route.fulfill({ status:mock.status, contentType:'application/json', body:JSON.stringify(mock.body) });
  });

  await p.goto('file://'+__dirname+'/index.html');
  await p.waitForTimeout(400);

  console.log('\n1. Settings persist to localStorage');
  check('settings start collapsed', await p.evaluate(()=>document.querySelector('#agent-cfg').open), false);
  await p.click('#btn-agent-cfg'); await p.waitForTimeout(150);
  check('Endpoint button opens them', await p.evaluate(()=>document.querySelector('#agent-cfg').open), true);
  await p.fill('#agent-url','https://mock.endpoint/api');
  await p.fill('#agent-pass','hunter2');
  await p.waitForTimeout(150);
  check('url stored', await p.evaluate(()=>localStorage.getItem('cc.agent.url')), 'https://mock.endpoint/api');
  check('pass stored', await p.evaluate(()=>localStorage.getItem('cc.agent.pass')), 'hunter2');

  console.log('\n2. Draft with no document is refused locally');
  await p.click('#btn-draft'); await p.waitForTimeout(200);
  check('no network call yet', lastRequest, null);
  check('status prompts', (await p.textContent('#agent-status')).includes('Paste the plan'), true);

  console.log('\n3. Draft round-trip');
  await p.fill('#agent-doc','Payout curve: 10/15/20% marginal on credited ARR...');
  await p.click('#btn-draft'); await p.waitForTimeout(400);
  check('passphrase sent as header', lastRequest.headers['x-passphrase'], 'hunter2');
  check('mode draft', lastRequest.body.mode, 'draft');
  check('columns sent', lastRequest.body.columns.length, 9);
  check('document sent', lastRequest.body.document.startsWith('Payout curve'), true);
  check('review table rendered', await p.evaluate(()=>document.querySelectorAll('#agent-out table').length), 2);
  check('rules listed', await p.evaluate(()=>document.querySelectorAll('#agent-out table')[1].querySelectorAll('tbody tr').length), 5);
  check('notes shown', (await p.textContent('#agent-out')).includes('Judgement calls'), true);
  check('validates cleanly', (await p.textContent('#agent-out')).includes('Validates cleanly'), true);
  check('apply is the primary action', await p.evaluate(()=>document.querySelector('#btn-apply-draft').className.includes('blue')), true);
  check('usage surfaced', (await p.textContent('#agent-status')).includes('5000 in / 1800 out'), true);

  console.log('\n4. Applying the draft drives the engine');
  await p.evaluate(()=>{ const P=CommissionEngine.getPlan(); P.rules=[]; P.rateTables=[]; CommissionEngine.setPlan(P); });
  await p.waitForTimeout(200);
  check('plan emptied first', await p.textContent('#out-variable'), '$0');
  await p.fill('#agent-doc','x'); await p.click('#btn-draft'); await p.waitForTimeout(400);
  await p.click('#btn-apply-draft'); await p.waitForTimeout(400);
  check('payout restored by the draft', await p.textContent('#out-variable'), '$110,200');
  check('rules rendered', await p.evaluate(()=>document.querySelectorAll('#rule-list .blk').length), 5);
  check('review panel cleared', await p.evaluate(()=>document.querySelector('#agent-out').innerHTML.trim()), '');

  console.log('\n5. Invalid draft is caught before it can be applied');
  mock.body.result = BAD_DRAFT;
  await p.click('#btn-draft'); await p.waitForTimeout(400);
  const out = await p.textContent('#agent-out');
  check('validation errors surfaced', out.includes('Validation errors'), true);
  check('names the missing table', out.includes('rt-does-not-exist'), true);
  check('unsupported terms surfaced', out.includes('SPIFF table'), true);
  check('apply is downgraded', await p.textContent('#btn-apply-draft'), 'Apply anyway');
  await p.click('#btn-discard-draft'); await p.waitForTimeout(150);
  check('discard clears', await p.evaluate(()=>document.querySelector('#agent-out').innerHTML.trim()), '');

  console.log('\n6. Verify mode');
  mock.body = { mode:'verify', result:VERIFY, model:'claude-sonnet-5' };
  await p.click('#btn-verify'); await p.waitForTimeout(400);
  check('mode verify', lastRequest.body.mode, 'verify');
  check('plan sent', typeof lastRequest.body.plan, 'object');
  check('audit trail sent', lastRequest.body.audit.includes('Audit trail'), true);
  check('result summary sent', lastRequest.body.result.includes('110,200.00'), true);
  const vo = await p.textContent('#agent-out');
  check('verdict shown', vo.includes('discrepancies'), true);
  check('finding shown', vo.includes('24 or more'), true);
  check('quote shown', vo.includes('GREATER THAN 24 months'), true);

  console.log('\n7. Endpoint errors surface, nothing is applied');
  mock = { status:401, body:{ error:'Wrong or missing passphrase.' } };
  await p.click('#btn-draft'); await p.waitForTimeout(400);
  check('error in status', (await p.textContent('#agent-status')).includes('Wrong or missing passphrase'), true);
  check('error in panel', (await p.textContent('#agent-out')).includes('Wrong or missing passphrase'), true);
  check('payout untouched', await p.textContent('#out-variable'), '$110,200');
  check('buttons re-enabled', await p.evaluate(()=>!document.querySelector('#btn-draft').disabled), true);

  console.log('\n8. Blank endpoint falls back to this origin');
  let sameOriginHit = null;
  await p.route('**/api/draft-plan', async route => {
    sameOriginHit = route.request().url();
    await route.fulfill({ status:200, contentType:'application/json',
      body: JSON.stringify({ mode:'draft', result:DRAFT, model:'claude-sonnet-5' }) });
  });
  await p.fill('#agent-url','');
  await p.click('#btn-draft'); await p.waitForTimeout(400);
  check('calls /api/draft-plan on this origin', /\/api\/draft-plan$/.test(sameOriginHit||''), true);
  check('draft rendered from same-origin call', (await p.textContent('#agent-out')).includes('Validates cleanly'), true);

  console.log('\n9. A missing function is explained, not just a 404');
  await p.unroute('**/api/draft-plan');
  await p.route('**/api/draft-plan', route => route.fulfill({ status:404, contentType:'text/html', body:'<html>Not found</html>' }));
  await p.click('#btn-draft'); await p.waitForTimeout(400);
  const miss = await p.textContent('#agent-status');
  check('names the deploy fix', miss.includes('commit netlify/functions/'), true);
  check('settings opened for review', await p.evaluate(()=>document.querySelector('#agent-cfg').open), true);
  check('payout untouched', await p.textContent('#out-variable'), '$110,200');

  console.log('\nerrors: ' + (errs.length ? errs.join(' | ') : 'none'));
  if (errs.length) fail++;
  console.log('\n'+pass+' passed, '+fail+' failed\n');
  await b.close();
  process.exit(fail?1:0);
})();

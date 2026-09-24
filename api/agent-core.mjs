/* =========================================================================
   Commission Calculator — agent core
   -------------------------------------------------------------------------
   Runtime-agnostic. Takes a web Request, returns a web Response. The host
   wrappers (Cloudflare Worker, Netlify Function) supply the environment.

   This file exists for one reason: the Anthropic API key must never reach a
   browser. GitHub Pages can only serve static files, so the page is served
   from there and this runs somewhere that can hold a secret.

   Two modes:
     draft   plan document (+ the CSV's column names) -> rate tables and rules
     verify  plan document + the resulting config and audit trail -> findings

   The model never produces a number that reaches a payout. It proposes
   configuration; the deterministic engine in index.html computes from it,
   and validatePlan() gates what is allowed through.
   ========================================================================= */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-5-5';

const MAX_DOCUMENT_CHARS = 60000;
const MAX_BODY_BYTES = 400000;

const OPS = ['is', 'isnot', 'contains', 'notcontains', 'oneof',
             'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'notblank'];

/* ------------------------------ schema ---------------------------------- */

const tierSchema = {
  type: 'object',
  properties: {
    from: { type: 'number', description: 'Lower bound, inclusive.' },
    to:   { type: ['number', 'null'], description: 'Upper bound, exclusive. null means no ceiling — only the last band may use it.' },
    rate: { type: 'number', description: 'Percent for value/cumulative tables. For attainment: payout points per attainment point (marginal), a multiplier (cliff), or a fraction of target (flat).' }
  },
  required: ['from', 'rate']
};

const rateTableSchema = {
  type: 'object',
  properties: {
    id:    { type: 'string', description: 'Short stable slug, e.g. "rt-new-business".' },
    name:  { type: 'string', description: 'Human label as the plan document words it.' },
    basis: { type: 'string', enum: ['value', 'cumulative', 'attainment'],
             description: 'value = bands on one deal\'s own size. cumulative = bands on a running balance across the period. attainment = bands on percent of quota.' },
    mode:  { type: 'string', enum: ['marginal', 'cliff', 'flat', 'retro', 'wholeDeal'],
             description: 'value: marginal|cliff|flat. cumulative: marginal|retro|wholeDeal. attainment: marginal|cliff|flat.' },
    poolBy:         { type: 'string', description: 'Cumulative only. Column name to keep a separate balance per value of. Empty for one balance.' },
    openingBalance: { type: 'number', description: 'Cumulative only. Credit carried in from a prior period.' },
    tiers: { type: 'array', items: tierSchema }
  },
  required: ['id', 'name', 'basis', 'mode', 'tiers']
};

const ruleSchema = {
  type: 'object',
  properties: {
    id:      { type: 'string' },
    name:    { type: 'string', description: 'What this rule covers, in the plan\'s own words.' },
    enabled: { type: 'boolean' },
    match:   { type: 'string', enum: ['all', 'any'] },
    conditions: {
      type: 'array',
      description: 'Empty array = catch-all, matches every deal. Exactly one catch-all belongs last.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'MUST be one of the supplied column names.' },
          op:    { type: 'string', enum: OPS },
          value: { type: 'string', description: 'Omit for blank/notblank. For between use "a, b". Dates compare as dates when both sides look like dates.' }
        },
        required: ['field', 'op']
      }
    },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['rateTable', 'percent', 'fixed', 'clawback', 'exclude'] },
        measureField:   { type: 'string', description: 'Column holding the dollar amount. MUST be one of the supplied columns.' },
        rateTableId:    { type: 'string', description: 'For rateTable: the value or cumulative table to apply. Never an attainment table.' },
        percent:        { type: 'number' },
        amount:         { type: 'number' },
        uplift:         { type: 'number', description: 'Multiplier on the measure BEFORE banding — a multi-year uplift, a kicker, a haircut. 1 means none.' },
        upliftField:    { type: 'string', description: 'Column whose value multiplies with uplift.' },
        creditPctField: { type: 'string', description: 'Split column where 100 means full credit. Blank cells count as 100.' },
        clawbackRate:      { type: 'number', description: 'Clawback only: the rate originally paid, as a percent.' },
        clawbackRateField: { type: 'string', description: 'Clawback only: column holding the rate originally paid. Overrides clawbackRate.' },
        reducesBalance:    { type: 'boolean', description: 'Clawback only: also remove the reversed amount from a cumulative balance.' }
      },
      required: ['type']
    }
  },
  required: ['id', 'name', 'match', 'conditions', 'action']
};

const componentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' }, name: { type: 'string' },
    weight: { type: 'number', description: 'Percent share of the variable at target. Components should total 100.' },
    quota: { type: 'number' },
    prorateQuota: { type: 'boolean' },
    actualSource: { type: 'string', enum: ['manual', 'sum'] },
    actualField: { type: 'string' },
    actual: { type: 'number' },
    payout: {
      type: 'object',
      properties: {
        rateTableId:  { type: 'string', description: 'Must name an attainment table.' },
        thresholdPct: { type: 'number' },
        capPct:       { type: ['number', 'null'] }
      },
      required: ['rateTableId']
    }
  },
  required: ['id', 'name', 'weight', 'quota', 'payout']
};

const DRAFT_TOOL = {
  name: 'emit_plan_config',
  description: 'Return the commission plan expressed as rate tables and rules.',
  input_schema: {
    type: 'object',
    properties: {
      planName: { type: 'string' },
      accrual: {
        type: 'object',
        description: 'The order deals are credited in. Matters whenever a cumulative table is used.',
        properties: {
          sortField: { type: 'string', description: 'Usually the close-date column. Empty keeps file order.' },
          direction: { type: 'string', enum: ['asc', 'desc'] }
        }
      },
      rateTables: { type: 'array', items: rateTableSchema },
      rules:      { type: 'array', items: ruleSchema },
      components: { type: 'array', items: componentSchema, description: 'Only for plans that pay a weighted share of a target incentive against quota. Usually empty.' },
      notes: {
        type: 'array', items: { type: 'string' },
        description: 'Each judgement call you made and why — ambiguities in the document, defaults you chose, anything a reviewer should check.'
      },
      unsupported: {
        type: 'array', items: { type: 'string' },
        description: 'Plan terms the schema cannot express. Say so here rather than approximating them silently. Empty if everything fit.'
      }
    },
    required: ['rateTables', 'rules', 'notes', 'unsupported']
  }
};

const VERIFY_TOOL = {
  name: 'report_findings',
  description: 'Report whether the configuration and its audit trail honour the plan document.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['matches', 'discrepancies', 'cannot_tell'] },
      summary: { type: 'string', description: 'Two sentences at most.' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['error', 'warning', 'note'] },
            area:     { type: 'string', description: 'Which rule, table or figure this concerns.' },
            detail:   { type: 'string', description: 'What the document says versus what the configuration does.' },
            quote:    { type: 'string', description: 'The words from the document that support this.' }
          },
          required: ['severity', 'area', 'detail']
        }
      }
    },
    required: ['verdict', 'summary', 'findings']
  }
};

/* ------------------------------ prompts --------------------------------- */

const SHARED_CONTRACT = `You configure a deterministic commission engine. You never compute a payout yourself — you describe the plan, and the engine calculates from your description. Getting the configuration right is the entire job.

HOW THE ENGINE WORKS

Rate tables hold bands. Bands are half-open [from, to), so a value landing exactly on a break belongs to the UPPER band. Bands must start at 0, be contiguous with no gaps or overlaps, and only the final band may have to = null.

  basis "value" — bands on a single deal's own size
    marginal   commission = SUM(dollars of the deal inside a band x that band's rate%)
    cliff      commission = deal value x the rate% of the band it lands in
    flat       commission = a flat dollar amount for the band it lands in

  basis "cumulative" — bands on a running balance across the period. Deals accrue
  their credited measure into a balance; the band depends on the balance standing
  before that deal. Use this whenever the plan tiers on year-to-date or
  period-to-date production rather than on one deal.
    marginal   each dollar of the balance earns its band's rate; a deal straddling
               a break is split across bands. Nothing is re-rated.
    retro      the band reached at period end re-rates ALL of the period's volume
               (a true-up). Use only when the document says the higher rate applies
               retroactively to everything.
    wholeDeal  each deal pays entirely at the band the balance sat in before it.

  basis "attainment" — bands on percent of quota, for quota components only.

Rules are tested top to bottom and THE FIRST MATCH WINS. A rule with no
conditions matches every deal; exactly one belongs at the bottom as a catch-all.
Order matters: put the most specific rules first.

Actions:
  rateTable  apply a value or cumulative table to measureField
  percent    pay a flat percent of measureField
  fixed      pay a flat dollar amount per deal
  clawback   reverse commission already paid, at the rate it was ORIGINALLY paid
             (clawbackRate, or clawbackRateField when the row carries it) — not
             at today's band
  exclude    the deal earns nothing

uplift multiplies the measure BEFORE banding. Use it for credit adjustments —
a multi-year uplift, a strategic-product kicker, a haircut. It changes what is
credited, not the rate applied to it. A rate change is a different band, not an
uplift; keep the two distinct.

creditPctField names a split column where 100 means full credit.

ORDER OF OPERATIONS
  1. each deal matches its first accepting rule
  2. measure = column value x uplift
  3. per-deal actions pay commission x credit%; cumulative tables accrue
     measure x credit% into the balance and band from there
  4. clawbacks subtract at their original rate
  5. quota components, then modifiers, then the total

RULES YOU MUST FOLLOW
- Only ever reference column names from the list you are given. Never invent one.
  If the plan needs a column that does not exist, put it in "unsupported".
- A threshold below which nothing is earned is a band with rate 0, not a
  separate concept.
- Read qualifying language exactly. "greater than 24 months" excludes 24.
  "18 months or more" includes 18. This is the most common place to be wrong.
- Period cutoffs are date conditions on the close-date column, e.g.
  op "gt" with value "2026-08-31".
- Prefer fewer, clearer rules. Two rules that differ only by uplift are correct;
  five near-duplicates are not.
- When the document is ambiguous, pick the reading a compensation analyst would
  defend, and record the choice in "notes". Do not silently guess.
- Anything the schema cannot express goes in "unsupported". An honest gap is far
  more useful than a plausible approximation.`;

function draftMessages(document, columns) {
  const cols = columns && columns.length
    ? columns.map(c => '  - ' + c).join('\n')
    : '  (no deal file loaded — the user will map columns afterwards; use the names the document itself uses)';
  return [{
    role: 'user',
    content: `Here is a compensation plan document.

<plan_document>
${document}
</plan_document>

The deal data has exactly these columns:
${cols}

Express this plan as rate tables and rules. Work through the document clause by
clause before you answer: identify the payout curve and whether it tiers on a
single deal or on period-to-date production, then the qualifying rules, credit
adjustments, splits, exclusions and clawbacks. Then call emit_plan_config.`
  }];
}

function verifyMessages(document, plan, audit, result) {
  return [{
    role: 'user',
    content: `A commission plan was configured from the document below, then run. Check the configuration and the resulting calculation against what the document actually says.

<plan_document>
${document}
</plan_document>

<configuration>
${JSON.stringify(plan, null, 2)}
</configuration>

<audit_trail>
${audit}
</audit_trail>

<result>
${result}
</result>

Look specifically for: qualifying thresholds applied with the wrong boundary
(greater-than versus at-least); the wrong tiering basis (per deal where the
document means period-to-date, or marginal where it means retroactive); missing
exclusions, splits, caps or clawbacks; rules ordered so an earlier one swallows
a later one; and any plan term with no configuration behind it at all.

Judge only against the document. If the document does not settle something, say
so rather than inventing a rule. Then call report_findings.`
  }];
}

/* ------------------------------ handler --------------------------------- */

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-passphrase',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, cors(origin))
  });
}

/* Browsers send the origin lowercased and with no trailing slash. Normalise
   the configured value the same way, so "https://MySite.netlify.app/" typed
   into a dashboard still matches rather than silently refusing every call. */
function normOrigin(o) {
  return String(o == null ? '' : o).trim().toLowerCase().replace(/\/+$/, '');
}

/* env: { ANTHROPIC_API_KEY, PASSPHRASE?, MODEL?, ALLOWED_ORIGIN? } */
export async function handle(request, env) {
  const allowed = normOrigin(env.ALLOWED_ORIGIN) || '*';
  const origin = allowed;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, origin);

  if (allowed !== '*') {
    const reqOrigin = request.headers.get('origin');
    if (reqOrigin && normOrigin(reqOrigin) !== allowed) {
      return json({ error: 'Origin ' + reqOrigin + ' is not allowed. ALLOWED_ORIGIN is set to ' + allowed + '.' }, 403, origin);
    }
  }

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'The server has no ANTHROPIC_API_KEY configured.' }, 500, origin);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413, origin);
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: 'Body is not valid JSON.' }, 400, origin);
  }

  if (env.PASSPHRASE) {
    const given = request.headers.get('x-passphrase') || body.passphrase || '';
    if (given !== env.PASSPHRASE) return json({ error: 'Wrong or missing passphrase.' }, 401, origin);
  }

  const mode = body.mode === 'verify' ? 'verify' : 'draft';
  const document = String(body.document || '').trim();
  if (!document) return json({ error: 'No plan document supplied.' }, 400, origin);
  if (document.length > MAX_DOCUMENT_CHARS) {
    return json({ error: 'Plan document is ' + document.length + ' characters; the limit is ' + MAX_DOCUMENT_CHARS + '.' }, 413, origin);
  }

  const tool = mode === 'verify' ? VERIFY_TOOL : DRAFT_TOOL;
  const messages = mode === 'verify'
    ? verifyMessages(document, body.plan || {}, String(body.audit || '').slice(0, 40000), String(body.result || '').slice(0, 4000))
    : draftMessages(document, Array.isArray(body.columns) ? body.columns : []);

  const payload = {
    model: env.MODEL || DEFAULT_MODEL,
    max_tokens: 8000,
    system: SHARED_CONTRACT,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name, disable_parallel_tool_use: true }
  };

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json({ error: 'Could not reach the Anthropic API.' }, 502, origin);
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    let detail = text.slice(0, 500);
    try { detail = (JSON.parse(text).error || {}).message || detail; } catch (e) { /* keep raw */ }
    return json({ error: 'Anthropic API returned ' + upstream.status + ': ' + detail }, upstream.status, origin);
  }

  let data;
  try { data = JSON.parse(text); } catch (e) { return json({ error: 'Anthropic API returned unparseable JSON.' }, 502, origin); }

  const block = (data.content || []).find(c => c.type === 'tool_use' && c.name === tool.name);
  if (!block) return json({ error: 'The model did not return a configuration.' }, 502, origin);

  return json({
    mode,
    result: block.input,
    usage: data.usage || null,
    model: data.model || payload.model
  }, 200, origin);
}

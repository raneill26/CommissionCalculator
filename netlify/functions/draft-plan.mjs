/* Netlify Function wrapper — use this instead if you move hosting to Netlify.
   Set ANTHROPIC_API_KEY and PASSPHRASE under Site settings > Environment
   variables. The page then calls /api/draft-plan on its own origin, so no
   CORS is involved.                                                        */
import { handle } from '../../api/agent-core.mjs';

export default async (request, context) => handle(request, process.env);

export const config = { path: '/api/draft-plan' };

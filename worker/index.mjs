/* Cloudflare Worker wrapper — recommended when the page is on GitHub Pages.
   Deploy:  cd worker && npx wrangler deploy
   Secrets: npx wrangler secret put ANTHROPIC_API_KEY
            npx wrangler secret put PASSPHRASE                */
import { handle } from '../api/agent-core.mjs';

export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};

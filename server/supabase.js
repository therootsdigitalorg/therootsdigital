'use strict';
/* Supabase server integration (@supabase/server core primitives + supabase-js).

   Reads the standard variables at call time:
     SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY(S), SUPABASE_SECRET_KEY(S), SUPABASE_JWKS_URL (or inline SUPABASE_JWKS)
   - User tokens (Authorization: Bearer <Supabase access token>) are verified against the project's JWKS,
     with the issuer pinned to this project.
   - API keys (apikey: sb_publishable_… / sb_secret_…) are checked against the configured keys.
   The secret key is used only server-side and is never returned to any client. */
/* Loaded on first use: @supabase/server depends on the ESM-only jose v6, which needs a Node version that supports
   require(esm) (22.12+). Loading lazily means a runtime problem here can only affect /sb-api, never the whole app. */
const { HttpError } = require('./util');
let core = null;
function lib() {
  if (core) return core;
  try { core = require('@supabase/server/core'); }
  catch (e) { console.error('[supabase] @supabase/server failed to load:', e); throw new HttpError(503, 'supabase_unavailable', `Supabase server library could not load on Node ${process.version}: ${e.message.split('\n')[0]}`); }
  return core;
}
const config = require('./config');
const store = require('./db');

const env = k => String(process.env[k] || '').trim();
const projectUrl = () => env('SUPABASE_URL').replace(/\/$/, '');
const status = () => ({
  configured: !!projectUrl(),
  url: projectUrl() || null,
  publishable_key: !!(env('SUPABASE_PUBLISHABLE_KEY') || env('SUPABASE_PUBLISHABLE_KEYS')),
  secret_key: !!(env('SUPABASE_SECRET_KEY') || env('SUPABASE_SECRET_KEYS')),
  jwks: env('SUPABASE_JWKS') ? 'inline' : env('SUPABASE_JWKS_URL') ? 'url' : projectUrl() ? 'well-known' : null,
});

/** Turn our Node request context into the Web Request that @supabase/server expects. */
function toRequest(ctx) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(ctx.headers || {})) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  return new Request(config.publicUrl + ctx.path, { method: ctx.method, headers });
}

/** Verify the caller. auth: 'user' | 'publishable' | 'secret' | array. Throws HttpError on failure. */
async function authenticate(ctx, auth = 'user') {
  if (!projectUrl()) throw new HttpError(503, 'supabase_not_configured', 'Supabase is not configured on this server (SUPABASE_URL).');
  const { data, error } = await lib().verifyAuth(toRequest(ctx), { auth, issuer: `${projectUrl()}/auth/v1` });
  if (error) {
    const st = error.status || 401;
    throw new HttpError(st >= 500 ? 503 : st, String(error.code || 'supabase_auth_failed').toLowerCase(), error.message || 'Supabase authentication failed.');
  }
  ctx.auth = { ...(ctx.auth || {}), key: data.authMode === 'user' ? 'supabase:user' : `supabase:${data.authMode}:${data.keyName || 'default'}` };
  return data;
}

const admin = () => lib().createAdminClient();
const asUser = token => lib().createContextClient({ auth: { token } });

/** Digital Hub account linked to a Supabase user: same email, and Supabase confirms the user owns that email. */
async function linkedAccount(claims) {
  const email = String(claims?.email || '').toLowerCase();
  if (!email || !claims?.id) return null;
  const u = store.byKey('users', email);
  if (!u || u.status !== 'active') return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.id)) return null; // Supabase user IDs are UUIDs
  let data, error;
  try { ({ data, error } = await admin().auth.admin.getUserById(claims.id)); } catch (e) { throw new HttpError(503, 'supabase_unavailable', 'Could not confirm the user with Supabase Auth.'); }
  if (error || !data?.user) return null;
  if (String(data.user.email || '').toLowerCase() !== email || !data.user.email_confirmed_at) return null;
  return u;
}

module.exports = { status, authenticate, admin, asUser, linkedAccount, projectUrl };

/**
 * MiniMe face source resolution — generateMinime / regenerateMinime.
 *
 * The bug: User.selfieUrl was always preferred, so a user with a real selfie
 * could not switch their avatar face to a premade. Fix threads an explicit
 * faceSource ('premade' | 'selfie') from the app, and passes the resolved face
 * to renderCurrentMinime as opts.faceUrl (its highest-priority face input).
 *
 * These stubs capture exactly what URL reaches renderCurrentMinime, which is
 * the URL gpt-image-1 actually renders. Pure stubs, no DB / no network.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const SELFIE_URL  = 'https://s3.example.com/avatars/real-selfie.webp';
const PREMADE_URL = 'https://s3.example.com/premade/premade-42.webp';
const PREMADE_ID  = 42;

// ---- Mutable fake-DB state, reset per scenario ----
let state;
function resetState(over = {}) {
  state = {
    userSelfieUrl: over.userSelfieUrl ?? null,     // User.selfieUrl
    premade: over.premade ?? { id: PREMADE_ID, imageUrl: PREMADE_URL, isActive: true },
    minimes: over.minimes ?? [],                    // rows for findFirst(orderBy createdAt desc)
    createdDrafts: [],
  };
}

let nextMinimeId = 1000;

const fakePrisma = {
  user: {
    findUnique: async () => ({ selfieUrl: state.userSelfieUrl }),
  },
  premadeAvatar: {
    findUnique: async ({ where }) =>
      state.premade && state.premade.id === where.id ? state.premade : null,
  },
  minime: {
    deleteMany: async () => ({ count: 0 }),
    findFirst: async ({ where }) => {
      // regenerate looks for an existing draft; generate's fallback looks for last
      let rows = state.minimes;
      if (where?.isDraft) rows = rows.filter(r => r.isDraft && !r.isSaved);
      return rows.length ? rows[0] : null;
    },
    create: async ({ data }) => {
      const row = { id: nextMinimeId++, ...data };
      state.createdDrafts.push(row);
      state.minimes.unshift(row); // newest first
      return row;
    },
    update: async ({ where, data }) => {
      const row = state.minimes.find(r => r.id === where.id) || {};
      Object.assign(row, data);
      return row;
    },
  },
};

// ---- Stub modules BEFORE requiring the controller ----
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

// Capture what renderCurrentMinime receives — this is the assertion surface.
let lastRenderCall = null;
const minimeGenPath = require.resolve('../utils/minimeGen');
require.cache[minimeGenPath] = {
  id: minimeGenPath, filename: minimeGenPath, loaded: true,
  exports: {
    renderCurrentMinime: async (userId, opts = {}) => {
      lastRenderCall = { userId, opts };
      return { rendered: true, faceUrlUsed: opts.faceUrl || null };
    },
  },
};

// Neutralise heavy/irrelevant deps that userController pulls in at module load.
for (const [p, ex] of [
  ['../utils/s3Upload', function () {}],
  ['../firebaseAdmin', {}],
  ['../utils/points', { addPointsWithMultiplier: async () => {} }],
  ['../utils/placeDistance', { validatePlaceDistance: () => {}, metersToMiles: () => 0 }],
]) {
  const rp = require.resolve(p);
  require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: ex };
}

const userController = require('../controllers/userController');

// ---- Fake req/res ----
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function callGenerate(body) {
  lastRenderCall = null;
  const req = { authData: { id: 7 }, body };
  const res = makeRes();
  await userController.generateMinime(req, res);
  return res;
}
async function callRegenerate(body) {
  lastRenderCall = null;
  const req = { authData: { id: 7 }, body };
  const res = makeRes();
  await userController.regenerateMinime(req, res);
  return res;
}

(async () => {
  console.log('\n=== generateMinime — face source resolution ===\n');

  // 1) THE BUG CASE: selfie exists, user picks premade → premade must win.
  resetState({ userSelfieUrl: SELFIE_URL });
  let res = await callGenerate({ faceSource: 'premade', premadeId: PREMADE_ID });
  ok('selfie exists + faceSource=premade → 200', res.statusCode === 200, `status=${res.statusCode}`);
  eq('  render gets PREMADE url (not old selfie)', lastRenderCall?.opts?.faceUrl, PREMADE_URL);
  eq('  draft row stores premade as selfieUrl', state.createdDrafts[0]?.selfieUrl, PREMADE_URL);

  // 2) faceSource=selfie → selfie used even if premadeId also sent.
  resetState({ userSelfieUrl: SELFIE_URL });
  res = await callGenerate({ faceSource: 'selfie', premadeId: PREMADE_ID });
  ok('faceSource=selfie → 200', res.statusCode === 200);
  eq('  render gets SELFIE url', lastRenderCall?.opts?.faceUrl, SELFIE_URL);

  // 3) faceSource=premade but premadeId missing → 400.
  resetState({ userSelfieUrl: SELFIE_URL });
  res = await callGenerate({ faceSource: 'premade' });
  ok('faceSource=premade + no premadeId → 400', res.statusCode === 400, `status=${res.statusCode}`);
  ok('  render NOT called', lastRenderCall === null);

  // 4) faceSource=premade but premade inactive → 400.
  resetState({ userSelfieUrl: null, premade: { id: PREMADE_ID, imageUrl: PREMADE_URL, isActive: false } });
  res = await callGenerate({ faceSource: 'premade', premadeId: PREMADE_ID });
  ok('inactive premade → 400', res.statusCode === 400, `status=${res.statusCode}`);

  // 5) faceSource=selfie but no selfie on file → 400 (nothing to render).
  resetState({ userSelfieUrl: null });
  res = await callGenerate({ faceSource: 'selfie' });
  ok('faceSource=selfie + no selfie → 400', res.statusCode === 400, `status=${res.statusCode}`);

  console.log('\n=== generateMinime — legacy fallback (no faceSource) ===\n');

  // 6) No faceSource, selfie exists → selfie (back-compat).
  resetState({ userSelfieUrl: SELFIE_URL });
  res = await callGenerate({ premadeId: PREMADE_ID });
  eq('no faceSource + selfie → render gets SELFIE', lastRenderCall?.opts?.faceUrl, SELFIE_URL);

  // 7) No faceSource, no selfie, premadeId present → premade (back-compat).
  resetState({ userSelfieUrl: null });
  res = await callGenerate({ premadeId: PREMADE_ID });
  eq('no faceSource + no selfie + premadeId → render gets PREMADE', lastRenderCall?.opts?.faceUrl, PREMADE_URL);

  // 8) No faceSource, no selfie, no premade, but a prior Minime has a face → reuse it.
  resetState({ userSelfieUrl: null, minimes: [{ id: 5, selfieUrl: PREMADE_URL, isDraft: false, isSaved: true, createdAt: new Date() }] });
  res = await callGenerate({});
  eq('no faceSource → falls back to last Minime face', lastRenderCall?.opts?.faceUrl, PREMADE_URL);

  console.log('\n=== regenerateMinime — must not revert premade to selfie ===\n');

  // 9) A premade draft exists AND User.selfieUrl is set → regenerate keeps premade.
  resetState({
    userSelfieUrl: SELFIE_URL,
    minimes: [{ id: 900, selfieUrl: PREMADE_URL, isDraft: true, isSaved: false, createdAt: new Date() }],
  });
  res = await callRegenerate({});
  ok('regenerate with premade draft → 200', res.statusCode === 200, `status=${res.statusCode}`);
  eq('  render gets DRAFT premade url (NOT User.selfieUrl)', lastRenderCall?.opts?.faceUrl, PREMADE_URL);
  eq('  render targets the existing draft', lastRenderCall?.opts?.targetMinimeId, 900);

  // 10) A selfie draft exists → regenerate keeps selfie.
  resetState({
    userSelfieUrl: SELFIE_URL,
    minimes: [{ id: 901, selfieUrl: SELFIE_URL, isDraft: true, isSaved: false, createdAt: new Date() }],
  });
  res = await callRegenerate({});
  eq('regenerate with selfie draft → render gets SELFIE', lastRenderCall?.opts?.faceUrl, SELFIE_URL);

  console.log('\n========================================');
  console.log(`Result: ${PASS} passed, ${FAIL} failed`);
  console.log('========================================');
  process.exit(FAIL > 0 ? 1 : 0);
})();

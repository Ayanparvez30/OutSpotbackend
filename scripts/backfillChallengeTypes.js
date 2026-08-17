// One-off backfill: assign a category `type` to the 27 launch challenges that
// were seeded with type = NULL (Morning Meals, Green Spot, …). Types picked to
// match each challenge's content, reusing the existing category set
// (food/outdoors/health/mental_health/fitness/social).
//
// Idempotent + safe: matches by exact title and only fills rows whose type is
// still null/empty — never overwrites an existing type.
//
//   node scripts/backfillChallengeTypes.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TYPE_BY_TITLE = {
  'Morning Meals':      'food',
  'Green Spot':         'outdoors',
  'Study Time':         'mental_health',
  'Steps Count':        'fitness',
  'Clean Space':        'mental_health',
  'Healthy Snack':      'health',
  'Sky Watch':          'outdoors',
  'Water Source':       'health',
  'Handwash Time':      'health',
  'Move 10':            'fitness',
  'Refill & Reuse':     'health',
  'Community Smile':    'social',
  'Grateful One':       'mental_health',
  'Walk 5 Days':        'fitness',
  'Home Garden':        'outdoors',
  'Reading Streak':     'mental_health',
  'Water Diary':        'health',
  'Clean Drive':        'social',
  'Active Week':        'fitness',
  'Healthy Kitchen':    'health',
  'Explore Nature':     'outdoors',
  'Skill Practice':     'mental_health',
  'Neighborhood Water': 'health',
  'Waste Less':         'social',
  'Community Care':     'social',
  'Early Riser':        'mental_health',
  'Local Food':         'food',
};

(async () => {
  let updated = 0, skipped = 0, notFound = 0;
  for (const [title, type] of Object.entries(TYPE_BY_TITLE)) {
    const r = await prisma.challenge.updateMany({
      where: { title, OR: [{ type: null }, { type: '' }] },
      data: { type },
    });
    if (r.count > 0) { updated += r.count; console.log(`  ${title} → ${type}  (${r.count})`); }
    else {
      // Either the title doesn't exist, or it already has a type.
      const exists = await prisma.challenge.count({ where: { title } });
      if (exists === 0) { notFound++; console.log(`  ${title} → NOT FOUND`); }
      else { skipped++; console.log(`  ${title} → already typed, skipped`); }
    }
  }

  const remaining = await prisma.challenge.count({ where: { OR: [{ type: null }, { type: '' }] } });
  console.log(`\nupdated=${updated} skipped=${skipped} notFound=${notFound} | null-type remaining=${remaining}`);
  await prisma.$disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

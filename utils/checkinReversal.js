const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/// Taking back the points from a check-in that turned out to be fake.
///
/// Until now the admin panel could only `locationPoint.delete()`. That removed
/// the row and nothing else: `User.totalPoints` kept the points, the
/// `PointsLedger` kept the credit, and the leaderboard — which sums the ledger —
/// never noticed. So detecting fraud produced a report nobody could act on.
///
/// Three details this gets right that a naive version would not:
///
///  1. **Reverse the ledger's number, not the check-in's.** `LocationPoint.points`
///     is the *base* award. What actually reached the user is
///     `PointsLedger.finalPoints`, after their active multiplier. Someone
///     farming on a 2x weekend would otherwise keep half of it.
///  2. **Keep the row.** Deleting destroys the evidence the decision was made
///     on, and orphans the S3 photo. The check-in is zeroed and left in place.
///  3. **Refuse to reverse twice.** A second click would otherwise take the
///     points again and push an honest balance negative.
///
/// No schema change: `PointsLedger.reason` is free text and the balance update
/// is an `increment`, so a negative value is simply a debit.

/// Marks the reversal in the ledger. Distinct from ADMIN_ADJUSTMENT so fraud
/// clawbacks can be told apart from an admin gifting or correcting points.
const REVERSAL_REASON = 'FRAUD_REVERSAL';

/// Reasons a check-in award is written under, across both award endpoints.
const AWARD_REASONS = ['LOCATION_VISIT', 'LOCATION_UPLOAD'];

/// What was credited for this check-in, and whether it has already been undone.
async function inspect(locationPointId, client = prisma) {
  const award = await client.pointsLedger.findFirst({
    where: { refId: locationPointId, reason: { in: AWARD_REASONS } },
    orderBy: { createdAt: 'asc' },
  });
  const reversal = await client.pointsLedger.findFirst({
    where: { refId: locationPointId, reason: REVERSAL_REASON },
  });
  return { award, reversal };
}

/// Reverses one check-in.
///
/// Returns `{ ok, reversed, message }`. Never throws for the ordinary "nothing
/// to do" cases — the admin screen shows the message.
async function reverseCheckIn(locationPointId, { adminName = 'admin' } = {}) {
  const id = parseInt(locationPointId, 10);
  if (!Number.isFinite(id)) {
    return { ok: false, reversed: 0, message: 'Bad check-in id' };
  }

  const point = await prisma.locationPoint.findUnique({ where: { id } });
  if (!point) {
    return { ok: false, reversed: 0, message: 'That check-in no longer exists' };
  }

  const { award, reversal } = await inspect(id);
  if (reversal) {
    return {
      ok: false,
      reversed: 0,
      message: 'That check-in has already been reversed',
    };
  }

  // No ledger row means the award predates the ledger, or the transaction that
  // wrote it failed halfway. Fall back to the check-in's own number — it is the
  // best figure available, and doing nothing would leave the points in place.
  const amount = award ? award.finalPoints : point.points || 0;
  if (amount <= 0) {
    // Still zero the row so the admin sees it was handled.
    await prisma.locationPoint.update({ where: { id }, data: { points: 0 } });
    return { ok: true, reversed: 0, message: 'That check-in was worth no points' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: point.userId },
      data: { totalPoints: { decrement: amount } },
    });
    await tx.pointsLedger.create({
      data: {
        userId: point.userId,
        basePoints: -amount,
        appliedMultiplier: 1,
        finalPoints: -amount,
        reason: REVERSAL_REASON,
        refId: id,
      },
    });
    // Zeroed rather than deleted: the row and its photo remain as the record of
    // what was reversed and why it looked wrong.
    await tx.locationPoint.update({ where: { id }, data: { points: 0 } });
  });

  console.log(
    `[reverseCheckIn] admin=${adminName} user=${point.userId} lp=${id} -${amount}pts placeId=${point.placeId}`,
  );

  return {
    ok: true,
    reversed: amount,
    userId: point.userId,
    message: `Took back ${amount} points from this check-in.`,
  };
}

module.exports = {
  reverseCheckIn,
  inspect,
  REVERSAL_REASON,
  AWARD_REASONS,
};

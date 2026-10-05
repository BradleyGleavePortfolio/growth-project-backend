import { Prisma } from '@prisma/client';

/**
 * B-609-3 persistence fence for the coach welcome message.
 *
 * The welcome scheduler claims a job with a fresh lease token, and every later
 * job write is conditional on that token. The CoachMessage INSERT itself must
 * be fenced the same way: otherwise a worker whose lease went stale, while a
 * second worker reclaimed the job and CANCELLED it (coach turned welcomes off,
 * client detached or deleted), could still persist and fan out the message.
 *
 * `holdWelcomeLease` runs inside the transaction that inserts the message. Its
 * UPDATE matches only the caller's live lease (status 'sending' + exact
 * lease_token) and takes the job row's lock until that transaction ends. Every
 * competing job write (reclaim, cancel, retry, mark sent) is an UPDATE of the
 * same row, so it either committed first (this returns false and nothing is
 * inserted) or waits until the message commits (the new holder then finds it
 * by CoachMessage.welcome_job_id and marks the job sent).
 */
export async function holdWelcomeLease(
  tx: Prisma.TransactionClient,
  jobId: string,
  lease: string,
): Promise<boolean> {
  const res = await tx.coachWelcomeMessageJob.updateMany({
    where: { id: jobId, status: 'sending', lease_token: lease },
    data: { lease_token: lease },
  });
  return res.count === 1;
}

/** The caller's welcome lease is gone: nothing was persisted or fanned out. */
export class WelcomeLeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`coach welcome job ${jobId}: lease no longer held; message not persisted`);
    this.name = 'WelcomeLeaseLostError';
  }
}

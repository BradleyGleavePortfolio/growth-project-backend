  /**
   * The pause itself. Under the DunningState row lock, then the purchase row
   * lock (the dunning lock order: DunningState before ClientPurchase), in ONE
   * transaction: record the dispute obligation, lock the cycle now with the
   * dispute marker (creating the row when the plan never failed a renewal),
   * end the entitlement and cancel the cycle's pending notices. A dispute id
   * seen before was applied by that earlier transaction, so a redelivery
   * after a coach restart changes nothing. Then, outside the transaction (no
   * Stripe call holds a row lock), billing is paused at Stripe under the
   * purchase's billing lease (`confirmDisputePause`); a failure throws so the
   * webhook is redelivered, and the sweep re-asserts the pause meanwhile.
   * The notices go out only after Stripe confirmed the pause (no copy claims
   * a pause before it is true).
   */
  private async applyDisputePause(input: {
    purchaseId: string;
    disputeId: string;
    chargeId: string | null;
    status: string;
    now: Date;
  }): Promise<{ opened: boolean; reason: string; claim?: DunningV2StepClaim }> {
    const { purchaseId, now } = input;
    let reason = 'not_eligible';
    let opened = false;
    let stateId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.lockDunningState(tx, purchaseId);
      await tx.$queryRaw`SELECT "id" FROM "ClientPurchase" WHERE "id" = ${purchaseId} FOR UPDATE`;
      const purchase = await tx.clientPurchase.findUnique({ where: { id: purchaseId } });
      if (!purchase || !DunningV2Service.isEligiblePurchase(purchase)) return;
      const { priorStatus } = await this.upsertDisputeObligation(tx, input);
      const state = await tx.dunningState.findUnique({ where: { purchase_id: purchaseId } });
      if (state && isDisputePausedRow(state)) {
        reason = 'already_paused';
        stateId = state.id;
        return;
      }
      if (priorStatus !== null) {
        reason = 'dispute_already_applied';
        return;
      }
      if (purchase.status === 'canceled') {
        reason = 'plan_ended';
        return;
      }
      const data = {
        status: 'active',
        step_index: DUNNING_V2_PAUSE_STEP,
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        last_failure_at: now,
        entered_at: now,
        // Access ends now; a cycle already locked keeps its lock instant.
        locked_out_at:
          state?.status === 'active' && state.locked_out_at ? state.locked_out_at : now,
        next_attempt_at: null,
        resolved_at: null,
        recovered_at: null,
        client_canceled_at: null,
        // Sol B-705-4: recorded, not yet confirmed at Stripe.
        billing_paused_at: null,
      };
      const row = state
        ? await tx.dunningState.update({
            where: { id: state.id },
            data: { ...data, reversal_count: { increment: 1 } },
          })
        : await tx.dunningState.create({
            data: { purchase_id: purchaseId, failure_count: 0, reversal_count: 1, ...data },
          });
      await tx.dunningNoticeDelivery.updateMany({
        where: { dunning_state_id: row.id, status: { in: ['pending', 'failed'] } },
        data: { status: 'canceled', next_attempt_at: null },
      });
      await tx.clientPurchase.update({
        where: { id: purchaseId },
        data: { entitlement_active: false },
      });
      reason = 'paused';
      opened = true;
      stateId = row.id;
    });
    if (!stateId) return { opened: false, reason };
    const effect = await this.confirmDisputePause(purchaseId, now);
    if (opened && effect.result !== 'not_paused') {
      this.telemetry.lockoutEntered(purchaseId, { dunning_state_id: stateId });
      this.telemetry.reversalDetected(purchaseId, { dunning_state_id: stateId, paused: true });
      this.logger.log(
        JSON.stringify({ event: 'dunning_v2.dispute_paused', purchase_id: purchaseId }),
      );
    }
    return { opened, reason, ...(effect.claim ? { claim: effect.claim } : {}) };
  }

  /**
   * D2d (Sol B-705-2/3, Opus B-705-1): make Stripe match a recorded dispute
   * pause, then tell the client and the coach once per pause (deterministic
   * outbox ids). Serialized per purchase on the ClientBillingLease, the lease
   * the coach restart and the client card payment / cancel also take; every
   * claim has its own fence, so its Stripe idempotency keys are its own and a
   * pause after a resume is a real request, never a replay of an older one.
   * 'deferred': another dispute pause or a coach restart holds the lease; it
   * reads the pause again under that lease and leaves Stripe matching it.
   * Any other holder throws (redelivered; the sweep re-asserts meanwhile).
   */
  private async confirmDisputePause(
    purchaseId: string,
    now: Date,
  ): Promise<{ result: 'confirmed' | 'deferred' | 'not_paused'; claim?: DunningV2StepClaim }> {
    const lease = await this.claimDisputeLease(purchaseId, 'dispute_pause');
    if (typeof lease === 'string') {
      if (lease.startsWith('dispute_')) return { result: 'deferred' };
      throw new Error('DUNNING_PAUSE_BILLING_BUSY');
    }
    let state: DunningState | null;
    try {
      state = await this.pauseUnderLease(lease);
    } finally {
      await this.releaseDisputeLease(lease);
    }
    if (!state) return { result: 'not_paused' };
    const enteredAt = state.entered_at as Date;
    const claim: DunningV2StepClaim = {
      dunningStateId: state.id,
      purchaseId,
      stepIndex: DUNNING_V2_PAUSE_STEP,
      isLateReversalCycle: true,
      cycleKey: dunningCycleKey(enteredAt),
    };
    const live = await this.claimWithOutbox(
      {
        id: state.id,
        status: 'active',
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        entered_at: enteredAt,
      },
      { step_index: DUNNING_V2_PAUSE_STEP },
      claim,
      now,
    );
    if (live) await this.dispatchClaim(claim, now);
    return { result: 'confirmed', claim };
  }

  /**
   * Under a held lease: read the pause again; when the plan is still paused,
   * pause Stripe with this lease's own key and record the confirmation
   * (Sol B-705-4: `billing_paused_at`). Returns the paused row, or null when
   * nothing is paused any more (a restart won), so nothing is paused at
   * Stripe against the authoritative state.
   */
  private async pauseUnderLease(lease: DisputeLease): Promise<DunningState | null> {
    const [state, purchase] = await Promise.all([
      this.prisma.dunningState.findUnique({ where: { purchase_id: lease.purchaseId } }),
      this.prisma.clientPurchase.findUnique({
        where: { id: lease.purchaseId },
        select: { stripe_subscription_id: true },
      }),
    ]);
    if (!state || !isDisputePausedRow(state) || !purchase?.stripe_subscription_id) return null;
    const enteredAt = state.entered_at as Date;
    await this.pauseBillingAtStripe(
      purchase.stripe_subscription_id,
      lease.purchaseId,
      dunningCycleKey(enteredAt),
      lease.fence,
    );
    await this.fencedTx(lease, async (tx) => {
      await tx.dunningState.updateMany({
        where: {
          id: state.id,
          status: 'active',
          last_failure_reason: DUNNING_V2_REVERSAL_REASON,
          entered_at: enteredAt,
        },
        data: { billing_paused_at: new Date() },
      });
    });
    return state;
  }

  /**
   * C-705-6 / Sol B-705-4: a paused plan whose Stripe pause is not confirmed
   * (the pause call failed, the lease was busy, or a restart stopped after
   * Stripe resumed) is paused again here. Never throws.
   */
  private async confirmUnconfirmedPause(purchaseId: string, now: Date): Promise<boolean> {
    try {
      const state = await this.prisma.dunningState.findUnique({
        where: { purchase_id: purchaseId },
      });
      if (!state || !isDisputePausedRow(state) || state.billing_paused_at) return false;
      return (await this.confirmDisputePause(purchaseId, now)).result === 'confirmed';
    } catch (err) {
      this.logger.warn(
        `dunning v2 pause re-assert failed purchase=${purchaseId}: ${dunningErrorCode(err)}`,
      );
      return false;
    }
  }

  /** Sweep step (behind the flag): re-assert unconfirmed dispute pauses. */
  private async reassertDisputePauses(now: Date, limit = 100): Promise<number> {
    const rows = await this.prisma.dunningState.findMany({
      where: {
        status: 'active',
        last_failure_reason: DUNNING_V2_REVERSAL_REASON,
        locked_out_at: { not: null },
        entered_at: { not: null },
        billing_paused_at: null,
      },
      orderBy: { entered_at: 'asc' },
      take: limit,
    });
    let confirmed = 0;
    for (const row of rows) {
      if (await this.confirmUnconfirmedPause(row.purchase_id, now)) confirmed += 1;
    }
    return confirmed;
  }

  /**
   * Pause collection at Stripe and stop every open invoice's retries (marked
   * uncollectible, not forgiven). The open-invoice list fails closed: an
   * incomplete list throws, so the event is redelivered rather than leaving
   * an invoice being retried. The key carries the lease fence: stable for
   * one attempt, new for every later attempt (Sol B-705-2, Opus B-705-1).
   */
  private async pauseBillingAtStripe(
    subscriptionId: string,
    purchaseId: string,
    cycleKey: string,
    fence: number,
  ): Promise<void> {
    if (!this.stripe) throw new Error('DUNNING_PAUSE_STRIPE_UNAVAILABLE');
    await this.stripe.pauseSubscriptionCollection({
      subscriptionId,
      idempotencyKey: `dunning_v2:dispute_pause:${purchaseId}:${cycleKey}:${fence}`,
    });
    const open = await this.stripe.listOpenInvoices(subscriptionId);
    for (const inv of open) {
      await this.stripe.markInvoiceUncollectible({
        invoiceId: inv.id,
        idempotencyKey: `dunning_v2:dispute_pause:${inv.id}`,
      });
    }
  }

  /**
   * R-DISPUTE-PAUSE coach restart. Only the plan's own coach (tenant check:
   * any other caller gets `not_found`, never another coach's data) may
   * restart a plan a dispute paused. Refused with a coded reason, before any
   * Stripe call: `not_paused`, `plan_ended`, `other_live_plan` (Opus
   * B-705-2: the client bought the package again, so a restart would bill two
   * plans), `billing_busy` (a pause or another billing action holds the
   * purchase's lease; Sol B-705-3). Under the lease: billing resumes at
   * Stripe, then, under the row locks, the cycle ends and access returns with
   * the status and period Stripe reports (Sol B-705-5), but only if the same
   * pause is still in place and no new dispute was recorded meanwhile. Every
   * exit that leaves the plan paused after the resume pauses Stripe again
   * with this attempt's own key (Opus B-705-1).
   */
  async restartAfterDisputePause(input: {
    coachUserId: string;
    purchaseId: string;
    now?: Date;
  }): Promise<{ restarted: boolean; reason: string }> {
    if (!this.enabled()) return { restarted: false, reason: 'flag_off' };
    const now = input.now ?? new Date();
    const first = await this.restartCandidate(input.coachUserId, input.purchaseId);
    if (typeof first === 'string') return { restarted: false, reason: first };
    const stripe = this.stripe;
    if (!stripe) return { restarted: false, reason: 'billing_unavailable' };
    const lease = await this.claimDisputeLease(input.purchaseId, 'dispute_restart');
    if (typeof lease === 'string') return { restarted: false, reason: 'billing_busy' };
    const run = { reason: 'plan_ended', resumeTried: false };
    try {
      run.reason = await this.restartUnderLease(stripe, lease, input.coachUserId, now, run);
    } finally {
      if (run.reason !== 'restarted' && run.resumeTried) {
        try {
          await this.pauseUnderLease(lease);
        } catch (err) {
          // Left unconfirmed (billing_paused_at null): the sweep re-asserts it.
          this.logger.warn(
            `dunning v2 restart re-pause failed purchase=${input.purchaseId}: ${dunningErrorCode(err)}`,
          );
        }
      }
      await this.releaseDisputeLease(lease);
    }
    // A pause recorded while this restart held the lease left its Stripe step
    // to this holder: make Stripe match it now.
    await this.confirmUnconfirmedPause(input.purchaseId, now);
    if (run.reason !== 'restarted') return { restarted: false, reason: run.reason };
    this.telemetry.lockoutExited(input.purchaseId, { dunning_state_id: first.state.id });
    this.logger.log(
      JSON.stringify({ event: 'dunning_v2.dispute_restarted', purchase_id: input.purchaseId }),
    );
    return { restarted: true, reason: run.reason };
  }

  /** Restart pre-checks, run before the lease and again under it. */
  private async restartCandidate(
    coachUserId: string,
    purchaseId: string,
  ): Promise<{ purchase: ClientPurchase; state: DunningState } | string> {
    const purchase = await this.prisma.clientPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase || purchase.coach_user_id !== coachUserId) return 'not_found';
    const state = await this.prisma.dunningState.findUnique({
      where: { purchase_id: purchase.id },
    });
    if (
      !state?.entered_at ||
      state.status !== 'active' ||
      state.last_failure_reason !== DUNNING_V2_REVERSAL_REASON
    ) {
      return 'not_paused';
    }
    if (PLAN_ENDED_STATUSES.has(purchase.status) || !DunningV2Service.isEligiblePurchase(purchase)) {
      return 'plan_ended';
    }
    if (await this.otherLivePlan(this.prisma, purchase)) return 'other_live_plan';
    return { purchase, state };
  }

  private async restartUnderLease(
    stripe: StripeConnectApiService,
    lease: DisputeLease,
    coachUserId: string,
    now: Date,
    run: { resumeTried: boolean },
  ): Promise<string> {
    const again = await this.restartCandidate(coachUserId, lease.purchaseId);
    if (typeof again === 'string') return again;
    const { purchase, state } = again;
    const enteredAt = state.entered_at as Date;
    const disputesBefore = await this.prisma.dunningDisputeObligation.count({
      where: { purchase_id: purchase.id },
    });
    // Unconfirmed from here: a crash after the resume leaves the sweep a pause
    // to re-assert, and the client is never told billing is paused meanwhile.
    await this.fencedTx(lease, async (tx) => {
      await tx.dunningState.updateMany({
        where: { id: state.id },
        data: { billing_paused_at: null },
      });
    });
    run.resumeTried = true;
    let sub: { status: string; current_period_end?: number };
    try {
      sub = await stripe.resumeSubscriptionCollection({
        subscriptionId: purchase.stripe_subscription_id as string,
        idempotencyKey: `dunning_v2:dispute_restart:${purchase.id}:${dunningCycleKey(enteredAt)}:${lease.fence}`,
      });
    } catch (err) {
      this.logger.warn(
        `dunning v2 restart failed purchase=${purchase.id}: ${dunningErrorCode(err)}`,
      );
      return 'billing_resume_failed';
    }
    const status = String(sub.status);
    if (!RESTART_LIVE_STATUSES.has(status)) return 'plan_ended';
    // The webhook's padding: access runs one day past the paid period.
    const accessExpiresAt =
      typeof sub.current_period_end === 'number'
        ? new Date(sub.current_period_end * 1000 + DUNNING_V2_DAY_MS)
        : null;
    let reason = 'plan_ended';
    await this.fencedTx(lease, async (tx) => {
      // Checkout's per client-coach lock, so a purchase of the same package
      // cannot become live between the check below and this restart.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE_SUBSCRIPTION_CHECKOUT}::int4, hashtext(${`${purchase.client_user_id}:${purchase.coach_user_id}`}))`;
      await this.lockDunningState(tx, purchase.id);
      await tx.$queryRaw`SELECT "id" FROM "ClientPurchase" WHERE "id" = ${purchase.id} FOR UPDATE`;
      const disputesNow = await tx.dunningDisputeObligation.count({
        where: { purchase_id: purchase.id },
      });
      if (disputesNow !== disputesBefore) {
        reason = 'new_dispute';
        return;
      }
      const fresh = await tx.clientPurchase.findUnique({ where: { id: purchase.id } });
      if (!fresh || PLAN_ENDED_STATUSES.has(fresh.status)) return;
      if (await this.otherLivePlan(tx, fresh)) {
        reason = 'other_live_plan';
        return;
      }
      const res = await tx.dunningState.updateMany({
        where: {
          id: state.id,
          status: 'active',
          last_failure_reason: DUNNING_V2_REVERSAL_REASON,
          entered_at: enteredAt,
        },
        data: {
          status: 'resolved',
          resolved_at: now,
          locked_out_at: null,
          next_attempt_at: null,
          billing_paused_at: null,
        },
      });
      if (res.count !== 1) {
        reason = 'not_paused';
        return;
      }
      // Sol B-705-5: the status and access period of the resumed
      // subscription, so the entitlement guard lets the client in (a
      // `disputed` or `chargeback_lost` status alone still answers 402).
      await tx.clientPurchase.update({
        where: { id: purchase.id },
        data: {
          entitlement_active: true,
          status,
          ...(accessExpiresAt ? { access_expires_at: accessExpiresAt } : {}),
        },
      });
      // Opus B-705-3: every dispute on record is covered by this restart; a
      // later closure or redelivery of one of them never ends access again.
      await tx.dunningDisputeObligation.updateMany({
        where: { purchase_id: purchase.id, restarted_at: null },
        data: { restarted_at: now },
      });
      await tx.notification.updateMany({
        where: {
          user_id: purchase.client_user_id,
          kind: NotificationKind.DUNNING_BLOCKER,
          read_at: null,
        },
        data: { read_at: now },
      });
      await tx.dunningNoticeDelivery.updateMany({
        where: { dunning_state_id: state.id, status: { in: ['pending', 'failed'] } },
        data: { status: 'canceled', next_attempt_at: null },
      });
      reason = 'restarted';
    });
    return reason;
  }

  /**
   * Opus B-705-2: another recurring plan of the same client for the same
   * package that checkout counts as live (same predicate as checkout).
   */
  private async otherLivePlan(db: DunningV2Db, purchase: ClientPurchase): Promise<boolean> {
    const other = await db.clientPurchase.findFirst({
      where: {
        id: { not: purchase.id },
        client_user_id: purchase.client_user_id,
        package_id: purchase.package_id,
        billing_type: 'recurring',
        stripe_subscription_id: { not: null },
        OR: [
          { entitlement_active: true },
          { trial_started_at: { not: null }, status: 'trialing' },
          { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
        ],
      },
      select: { id: true },
    });
    return other != null;
  }

  /**
   * CAS claim of the purchase's ClientBillingLease (free when no holder or
   * expired; every claim increments the fence). Busy: the holder token, whose
   * prefix names the kind of action holding it.
   */
  private async claimDisputeLease(
    purchaseId: string,
    kind: 'dispute_pause' | 'dispute_restart',
  ): Promise<DisputeLease | string> {
    try {
      await this.prisma.clientBillingLease.upsert({
        where: { purchase_id: purchaseId },
        create: { purchase_id: purchaseId, holder: null, holder_until: null, fence: 0 },
        update: {},
      });
    } catch (err) {
      // Two first-time claimers raced on the create; the row exists now.
      if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
    }
    const now = new Date();
    const token = `${kind}:${randomUUID()}`;
    const res = await this.prisma.clientBillingLease.updateMany({
      where: {
        purchase_id: purchaseId,
        OR: [{ holder: null }, { holder_until: null }, { holder_until: { lte: now } }],
      },
      data: {
        holder: token,
        holder_until: new Date(now.getTime() + DISPUTE_BILLING_LEASE_MS),
        fence: { increment: 1 },
      },
    });
    const row = await this.prisma.clientBillingLease.findUnique({
      where: { purchase_id: purchaseId },
    });
    if (res.count !== 1 || !row || row.holder !== token) return row?.holder ?? 'unknown';
    return { purchaseId, token, fence: row.fence };
  }

  /** Writes that re-check the lease (CAS on holder) in the same transaction. */
  private async fencedTx(
    lease: DisputeLease,
    fn: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ok = await tx.clientBillingLease.updateMany({
        where: { purchase_id: lease.purchaseId, holder: lease.token },
        data: { holder_until: new Date(Date.now() + DISPUTE_BILLING_LEASE_MS) },
      });
      if (ok.count !== 1) throw new Error('DUNNING_BILLING_LEASE_LOST');
      await fn(tx);
    });
  }

  private async releaseDisputeLease(lease: DisputeLease): Promise<void> {
    try {
      await this.prisma.clientBillingLease.updateMany({
        where: { purchase_id: lease.purchaseId, holder: lease.token },
        data: { holder: null, holder_until: null },
      });
    } catch (err) {
      // An unreleased lease expires on its own after DISPUTE_BILLING_LEASE_MS.
      this.logger.warn(
        `dunning v2 billing lease release failed purchase=${lease.purchaseId}: ${dunningErrorCode(err)}`,
      );
    }
  }


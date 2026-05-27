-- PR AI-3 (PRODUCT-1): observable materialisation state for approved drafts.
-- `materialised_at` is set the moment a CapabilityMaterializer reports success
-- and serves as the idempotency marker so concurrent approvals cannot double-
-- send. `materialised_ref` carries the downstream row id (e.g. CoachMessage.id)
-- so support can trace approved-draft -> sent-message.
ALTER TABLE "AiActionDraft" ADD COLUMN "materialised_at" TIMESTAMP(3);
ALTER TABLE "AiActionDraft" ADD COLUMN "materialised_ref" TEXT;

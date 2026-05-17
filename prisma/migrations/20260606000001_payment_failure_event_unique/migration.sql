ALTER TABLE "PaymentFailure" ADD CONSTRAINT "PaymentFailure_stripe_event_id_key" UNIQUE ("stripe_event_id");

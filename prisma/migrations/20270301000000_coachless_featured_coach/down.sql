-- Down for 20270301000000_coachless_featured_coach. Drops the owner's
-- featured-coach offer copy, the redemption ledger and the Roman card state;
-- use only for a confirmed pre-launch defect.
DROP TABLE IF EXISTS "CoachlessPromptState";
DROP TABLE IF EXISTS "CoachCodeRedemption";
DROP TABLE IF EXISTS "FeaturedCoachConfig";

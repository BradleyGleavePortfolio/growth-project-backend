// PR-7 — typed errors for the AssignableAssetResolver registry + resolvers.
// Kept as plain Error subclasses (not NestJS HttpException) because the
// callers in PR-9/PR-10 (drip executor + immediate fan-out) translate these
// into ScheduledDrop.failure_reason / retry state, not HTTP responses.

export class UnknownAssignableAssetTypeError extends Error {
  readonly code = 'ASSIGNABLE_ASSET_RESOLVER_UNKNOWN_TYPE';
  constructor(public readonly assetType: string) {
    super(
      `No AssignableAssetResolver registered for asset_type=${assetType}`,
    );
    this.name = 'UnknownAssignableAssetTypeError';
  }
}

export class SubCoachOutOfScopeError extends Error {
  readonly code = 'ASSIGNABLE_ASSET_RESOLVER_SUB_COACH_OUT_OF_SCOPE';
  constructor(
    public readonly coachId: string,
    public readonly clientId: string,
  ) {
    super(
      `Coach ${coachId} is not authorised to materialise for client ${clientId} (sub-coach scope check failed)`,
    );
    this.name = 'SubCoachOutOfScopeError';
  }
}

export class MediaAssetNotFoundError extends Error {
  readonly code = 'ASSIGNABLE_ASSET_RESOLVER_MEDIA_ASSET_NOT_FOUND';
  constructor(public readonly mediaAssetId: string) {
    super(
      `CoachMediaAsset ${mediaAssetId} does not exist (upload pipeline is PR-12)`,
    );
    this.name = 'MediaAssetNotFoundError';
  }
}

export class MealPlanNotFoundError extends Error {
  readonly code = 'ASSIGNABLE_ASSET_RESOLVER_MEAL_PLAN_NOT_FOUND';
  constructor(public readonly mealPlanId: string) {
    super(
      `DailyMealPlan ${mealPlanId} does not exist for the acting tenant (archived or cross-tenant)`,
    );
    this.name = 'MealPlanNotFoundError';
  }
}

export class AutoMessageBodyMissingError extends Error {
  readonly code = 'ASSIGNABLE_ASSET_RESOLVER_AUTO_MESSAGE_EMPTY';
  constructor() {
    super(
      'auto_message resolver requires displayCaption (or displayTitle) to carry the message body',
    );
    this.name = 'AutoMessageBodyMissingError';
  }
}

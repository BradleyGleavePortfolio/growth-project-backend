/**
 * Coach media error taxonomy. Each error maps cleanly to a controller
 * HTTP status:
 *   MediaAssetNotFoundError -> 404 ASSET_NOT_FOUND
 *   MediaAssetForbiddenError -> 404 ASSET_NOT_FOUND (don't leak existence)
 *   InvalidUploadConfirmationError -> 400 INVALID_CONFIRMATION
 *   AssetReferencedError -> 409 ASSET_REFERENCED (soft-delete blocked)
 */

export class MediaAssetNotFoundError extends Error {
  readonly code = 'ASSET_NOT_FOUND';
  constructor(assetId: string) {
    super(`No CoachMediaAsset with id ${assetId}`);
    this.name = 'MediaAssetNotFoundError';
  }
}

export class InvalidUploadConfirmationError extends Error {
  readonly code = 'INVALID_CONFIRMATION';
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidUploadConfirmationError';
  }
}

export class AssetReferencedError extends Error {
  readonly code = 'ASSET_REFERENCED';
  constructor(
    public readonly grantCount: number,
    public readonly contentCount: number,
  ) {
    super(
      `Asset cannot be deleted — referenced by ${grantCount} client grants and ${contentCount} package contents`,
    );
    this.name = 'AssetReferencedError';
  }
}

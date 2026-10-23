/**
 * PHOTO-CHECK-BE: the automatic photo check on a space chat photo send
 * (#167-7 IMAGES op 1, owner: "It's checked automatically. You can report it").
 *
 * Runs after the upload checks (JPEG, size, key signature, key age) and before
 * the message, its photo row or the sent copy is written. The checked upload's
 * bytes, plus the caption when there is one, go to OpenAI's moderation
 * endpoint through the AI egress (AiEgressService.openAiModerationCreate):
 *   clean      the send goes on, unchanged.
 *   flagged    422 PHOTO_NOT_ALLOWED. Nothing is written or published, and the
 *              upload is erased now; its upload erasure row (recorded when the
 *              link was signed) still erases it at link death, like any unsent
 *              upload, if this delete fails.
 *   otherwise  503 PHOTO_CHECK_UNAVAILABLE, fail closed: no key, a timeout, a
 *              429 or 5xx, a network error, an answer we cannot read, or a
 *              download that is not the whole checked upload. The upload is
 *              kept, so the member can send it again while the key is good.
 * Logs carry the outcome only: never the photo, the caption or who sent it.
 */
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { AiEgressService } from '../../ai-egress/ai-egress.service';
import { createOpenAiModerationClient } from '../../ai-egress/provider-clients';
import type { CommunityImageStore } from './community-image-store';

export const PHOTO_CHECK_MODEL = 'omni-moderation-latest';
/** Per step (download, then the check): a member is waiting on the send. */
export const PHOTO_CHECK_TIMEOUT_MS = 5_000;

const logger = new Logger('CommunityPhotoCheck');

type Outcome = 'clean' | 'flagged' | 'not_configured' | 'download_failed' | 'check_failed' | 'unreadable';

async function outcome(
  egress: AiEgressService,
  store: CommunityImageStore,
  key: string,
  ownerId: string,
  size: number,
  caption: string,
): Promise<Outcome> {
  const apiKey = process.env.PHOTO_CHECK_OPENAI_API_KEY?.trim();
  if (!apiKey) return 'not_configured';
  let jpeg: Buffer;
  try {
    const url = await store.createSignedDownload(key, 60, ownerId);
    const res = url ? await fetch(url, { signal: AbortSignal.timeout(PHOTO_CHECK_TIMEOUT_MS) }) : null;
    jpeg = res?.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  } catch {
    return 'download_failed';
  }
  // The whole checked object, JPEG from its first bytes, or nothing is sent.
  if (jpeg.length !== size || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return 'download_failed';
  let results: unknown;
  try {
    const text = caption.trim() ? [{ type: 'text' as const, text: caption }] : [];
    const image = { type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } };
    ({ results } = await egress.openAiModerationCreate(
      createOpenAiModerationClient(apiKey),
      { model: PHOTO_CHECK_MODEL, input: [...text, image] },
      PHOTO_CHECK_TIMEOUT_MS,
    ));
  } catch {
    return 'check_failed';
  }
  const flags = Array.isArray(results) ? results.map((r) => (r as { flagged?: unknown } | null)?.flagged) : [];
  if (flags.length === 0 || flags.some((f) => typeof f !== 'boolean')) return 'unreadable';
  return flags.includes(true) ? 'flagged' : 'clean';
}

/** Throws unless the photo may be posted; see the file header. */
export async function assertPhotoAllowed(
  egress: AiEgressService,
  store: CommunityImageStore,
  key: string,
  ownerId: string,
  size: number,
  caption: string,
): Promise<void> {
  const result = await outcome(egress, store, key, ownerId, size, caption);
  if (result === 'clean') return;
  if (result === 'flagged') {
    const { failed } = await store.removeObjects([key]).catch(() => ({ failed: true }));
    logger.log(`community.photo_check outcome=flagged${failed ? ' erase=deferred_to_link_expiry' : ''}`);
    throw new UnprocessableEntityException({ error: 'invalid_image', code: 'PHOTO_NOT_ALLOWED' });
  }
  logger.warn(`community.photo_check outcome=${result}`);
  throw new ServiceUnavailableException({ error: 'unavailable', code: 'PHOTO_CHECK_UNAVAILABLE' });
}

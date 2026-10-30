/**
 * PHOTO-CHECK-BE: the automatic check on a space chat photo and its caption
 * (#167-7 IMAGES op 1, owner: "It's checked automatically. You can report it").
 *
 * Runs after the upload checks (JPEG, size, key signature, key age) and before
 * the message, its photo row or the sent copy is written; and (FR-1152, Sol B1)
 * before every caption edit on a photo message. Through the AI egress
 * (AiEgressService.openAiModerationCreate), the checked upload's bytes, with
 * every metadata segment removed (FR-1187, image-metadata.ts), go to OpenAI's
 * moderation endpoint in one request, and the caption, when there is one, in
 * another, at the same time. Each part is judged by PHOTO_CHECK_RULES
 * (#172-3 op 2, "with a moderate tolerance"):
 *   clean            the send or edit goes on, unchanged.
 *   photo refused    422 PHOTO_NOT_ALLOWED. Nothing is written or published,
 *                    and the upload is erased now; its upload erasure row
 *                    (recorded when the link was signed) still erases it at
 *                    link death, like any unsent upload, if this delete fails.
 *   caption refused  (photo clean or unchecked) 422 CAPTION_NOT_ALLOWED.
 *                    Nothing is written; the upload is kept, so the member can
 *                    send the same photo with another caption (Opus C-3). On an
 *                    edit the message keeps its old caption.
 *   otherwise        503 PHOTO_CHECK_UNAVAILABLE, fail closed: no key or the
 *                    ghost value (photoCheckKey), a timeout, a 429 or 5xx, a
 *                    network error, an answer we cannot read, a download
 *                    that is not the whole checked upload, or a JPEG whose
 *                    segments cannot be walked to strip its metadata. The upload is kept,
 *                    so the member can send it again while the key is good.
 * A refusal for self-harm intent or instructions, in the photo or the caption,
 * also calls `onSelfHarm` once (#172-5 op 2: the coach alert), before it throws.
 * Logs carry the outcome only: never the photo, the caption, a category or who
 * sent it.
 */
import { Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type OpenAI from 'openai';
import type { AiEgressService } from '../../ai-egress/ai-egress.service';
import { createOpenAiModerationClient } from '../../ai-egress/provider-clients';
import { photoCheckKey } from '../../common/env-validation';
import type { CommunityImageStore } from './community-image-store';
import { stripJpegMetadata } from './image-metadata';

export const PHOTO_CHECK_MODEL = 'omni-moderation-latest';
/** Per step (download, then the check), each start to finish: a member is waiting. */
export const PHOTO_CHECK_TIMEOUT_MS = 5_000;

/**
 * When a score refuses: at or above the number; 'flag' refuses whenever
 * OpenAI's own flag for the category is set, at any score; null never refuses
 * (the post goes up, and reporting is the backstop).
 */
export type PhotoCheckRule = number | 'flag' | null;

/**
 * #172-3 op 2, the refusal table, per OpenAI omni-moderation category
 * (https://platform.openai.com/docs/guides/moderation): `photo` judges the
 * photo's scores, `caption` the caption's. OpenAI scores a photo only for
 * sexual, violence, violence/graphic and the three self-harm categories; the
 * rest are text only, so their photo rule is null. Scores are 0 to 1; the
 * photo numbers are set high on purpose (moderate tolerance: swimwear, a
 * boxing or gym photo, a joking self-loathing caption post). Starting values,
 * to be checked on a real phone and recalibrated when OpenAI updates the model.
 */
export const PHOTO_CHECK_RULES: Readonly<Record<string, { photo: PhotoCheckRule; caption: PhotoCheckRule }>> = {
  // Refuse (photo and caption).
  sexual: { photo: 0.85, caption: 0.8 },
  'violence/graphic': { photo: 0.7, caption: 0.7 },
  'self-harm/intent': { photo: 0.7, caption: 0.7 },
  'self-harm/instructions': { photo: 0.5, caption: 0.5 },
  // Refuse (caption: text only).
  hate: { photo: null, caption: 0.7 },
  'hate/threatening': { photo: null, caption: 0.5 },
  'harassment/threatening': { photo: null, caption: 0.7 },
  'sexual/minors': { photo: null, caption: 'flag' },
  // Post: broad violence and self-harm, harassment, illicit.
  violence: { photo: null, caption: null },
  'self-harm': { photo: null, caption: null },
  harassment: { photo: null, caption: null },
  illicit: { photo: null, caption: null },
  'illicit/violent': { photo: null, caption: null },
};

/** #172-5: a refusal for one of these raises the coach alert. */
export const PHOTO_CHECK_ALERT_CATEGORIES: readonly string[] = ['self-harm/intent', 'self-harm/instructions'];

type Part = 'photo' | 'caption';
/** Categories refused, or why the part could not be judged. */
type Verdict = { refused: string[] } | { unavailable: 'not_configured' | 'download_failed' | 'check_failed' | 'unreadable' };

const logger = new Logger('CommunityPhotoCheck');

/** Runs `step` with a signal; rejects at `ms` from the start, whatever it is waiting on. */
async function within<T>(ms: number, step: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('community.photo_check deadline'));
    }, ms);
  });
  try {
    return await Promise.race([step(abort.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The categories one moderation result refuses for this part, or null when it
 * cannot be read. A score counts for the part unless its
 * category_applied_input_types names only the other input type (each request
 * carries one part, so a score always comes from that part).
 */
export function refusedCategories(result: unknown, part: Part): string[] | null {
  const r = result as {
    categories?: Record<string, unknown> | null;
    category_scores?: Record<string, unknown> | null;
    category_applied_input_types?: Record<string, unknown> | null;
  } | null;
  if (!r || typeof r !== 'object' || !r.category_scores || typeof r.category_scores !== 'object') return null;
  const input = part === 'photo' ? 'image' : 'text';
  const refused: string[] = [];
  for (const [category, rules] of Object.entries(PHOTO_CHECK_RULES)) {
    const rule = rules[part];
    if (rule === null) continue;
    const applied = r.category_applied_input_types?.[category];
    if (Array.isArray(applied) && applied.length > 0 && !applied.includes(input)) continue;
    const value = rule === 'flag' ? r.categories?.[category] : r.category_scores[category];
    if (rule === 'flag' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (rule === 'flag' ? value === true : (value as number) >= rule) refused.push(category);
  }
  return refused;
}

async function judge(
  egress: AiEgressService,
  apiKey: string,
  part: Part,
  input: OpenAI.ModerationMultiModalInput,
): Promise<Verdict> {
  let results: unknown;
  try {
    ({ results } = await egress.openAiModerationCreate(
      createOpenAiModerationClient(apiKey),
      { model: PHOTO_CHECK_MODEL, input: [input] },
      PHOTO_CHECK_TIMEOUT_MS,
    ));
  } catch {
    return { unavailable: 'check_failed' };
  }
  // One input, one result.
  const refused = Array.isArray(results) && results.length === 1 ? refusedCategories(results[0], part) : null;
  return refused ? { refused } : { unavailable: 'unreadable' };
}

async function judgePhoto(
  egress: AiEgressService,
  apiKey: string,
  store: CommunityImageStore,
  key: string,
  ownerId: string,
  size: number,
): Promise<Verdict> {
  let jpeg: Buffer;
  try {
    // Signing, the headers and the body, all inside the one deadline.
    jpeg = await within(PHOTO_CHECK_TIMEOUT_MS, async (signal) => {
      const url = await store.createSignedDownload(key, 60, ownerId);
      const res = url ? await fetch(url, { signal }) : null;
      return res?.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    });
  } catch {
    return { unavailable: 'download_failed' };
  }
  // The whole checked object, JPEG from its first bytes, or nothing is sent.
  if (jpeg.length !== size || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) {
    return { unavailable: 'download_failed' };
  }
  // FR-1187 (LS-1187 B1): OpenAI gets a copy with no metadata (image-metadata.ts); the stored photo is unchanged.
  const bare = stripJpegMetadata(jpeg);
  if (!bare) return { unavailable: 'unreadable' };
  return judge(egress, apiKey, 'photo', {
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${bare.toString('base64')}` },
  });
}

const judgeCaption = (egress: AiEgressService, apiKey: string, caption: string): Promise<Verdict> =>
  caption.trim() ? judge(egress, apiKey, 'caption', { type: 'text', text: caption }) : Promise.resolve({ refused: [] });

/** Throws for a refusal or an unavailable check (see the file header); calls the alert first. */
async function settle(
  photo: Verdict | null,
  caption: Verdict,
  onSelfHarm: (() => Promise<void>) | undefined,
  erase: () => Promise<boolean>,
): Promise<void> {
  const refused = (v: Verdict | null) => (v && 'refused' in v && v.refused.length > 0 ? v.refused : null);
  const photoRefused = refused(photo);
  const captionRefused = refused(caption);
  if (!photoRefused && !captionRefused) {
    const why = [photo, caption].find((v): v is Extract<Verdict, { unavailable: string }> => !!v && 'unavailable' in v);
    if (!why) return;
    logger.warn(`community.photo_check outcome=${why.unavailable}`);
    throw new ServiceUnavailableException({ error: 'unavailable', code: 'PHOTO_CHECK_UNAVAILABLE' });
  }
  const alert = [...(photoRefused ?? []), ...(captionRefused ?? [])].some((c) => PHOTO_CHECK_ALERT_CATEGORIES.includes(c));
  if (alert && onSelfHarm) {
    try {
      await onSelfHarm();
    } catch {
      // The refusal stands whatever happens to the alert.
      logger.warn('community.photo_check alert=failed');
    }
  }
  const erased = photoRefused ? await erase() : true;
  logger.log(
    `community.photo_check outcome=refused part=${photoRefused ? 'photo' : 'caption'}${alert ? ' alert=raised' : ''}${erased ? '' : ' erase=deferred_to_link_expiry'}`,
  );
  if (photoRefused) throw new UnprocessableEntityException({ error: 'invalid_image', code: 'PHOTO_NOT_ALLOWED' });
  throw new UnprocessableEntityException({ error: 'invalid_caption', code: 'CAPTION_NOT_ALLOWED' });
}

/** A photo send: throws unless the photo and its caption may be posted; see the file header. */
export async function assertPhotoAllowed(
  egress: AiEgressService,
  store: CommunityImageStore,
  key: string,
  ownerId: string,
  size: number,
  caption: string,
  onSelfHarm?: () => Promise<void>,
): Promise<void> {
  const apiKey = photoCheckKey();
  if (!apiKey) return settle({ unavailable: 'not_configured' }, { refused: [] }, onSelfHarm, async () => true);
  const [photo, text] = await Promise.all([
    judgePhoto(egress, apiKey, store, key, ownerId, size),
    judgeCaption(egress, apiKey, caption),
  ]);
  return settle(photo, text, onSelfHarm, async () => {
    const { failed } = await store.removeObjects([key]).catch(() => ({ failed: true }));
    return !failed;
  });
}

/** A caption edit on a photo message (Sol B1): the same check on the new caption. */
export async function assertCaptionAllowed(
  egress: AiEgressService,
  caption: string,
  onSelfHarm?: () => Promise<void>,
): Promise<void> {
  if (!caption.trim()) return;
  const apiKey = photoCheckKey();
  if (!apiKey) return settle(null, { unavailable: 'not_configured' }, onSelfHarm, async () => true);
  return settle(null, await judgeCaption(egress, apiKey, caption), onSelfHarm, async () => true);
}

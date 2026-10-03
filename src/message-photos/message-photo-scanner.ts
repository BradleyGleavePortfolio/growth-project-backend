/**
 * Image moderation hook (A6-PHOTOS).
 *
 * Every photo passes through a MessagePhotoScanner after its metadata is
 * stripped and BEFORE it can be attached to a message. A 'block' verdict
 * rejects the photo (`message_photo.rejected`) and erases the upload.
 *
 * Launch posture (stated honestly, same as community voice notes): no
 * automated image classifier is wired, so the default scanner allows every
 * photo and records `scanner: 'none'`. Safety for photos at launch is the
 * #610-style human loop: every photo can be reported, a reported photo is
 * hidden for the reporter at once, the TGP team reviews it in the
 * owner queue (GET /admin/message-photos/reports, 15-minute signed review
 * links, 24-hour respond-by) and removes it (bytes erased) or dismisses the
 * report; either side can block the other. A vendor classifier plugs in by
 * providing MESSAGE_PHOTO_SCANNER, with no change to the upload flow.
 */

export const MESSAGE_PHOTO_SCANNER = Symbol('MESSAGE_PHOTO_SCANNER');

export interface MessagePhotoScanInput {
  bytes: Buffer;
  contentType: string;
  width: number;
  height: number;
  uploaderId: string;
}

export interface MessagePhotoScanResult {
  verdict: 'allow' | 'block';
  /** Which scanner decided ('none' when no classifier is configured). */
  scanner: string;
  /** Optional category label from a classifier (never user content). */
  label?: string;
}

export interface MessagePhotoScanner {
  scan(input: MessagePhotoScanInput): Promise<MessagePhotoScanResult>;
}

export class NoopMessagePhotoScanner implements MessagePhotoScanner {
  async scan(): Promise<MessagePhotoScanResult> {
    return { verdict: 'allow', scanner: 'none' };
  }
}

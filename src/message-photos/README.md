# Photos in coach-client messages (A6-PHOTOS)

Behind `FEATURE_MESSAGE_PHOTOS` (default OFF; only `true` turns it on). OFF gates
upload intent, finalize and sending with photos. Reads, sender delete,
moderation and erasure stay on, so photos already sent keep rendering and can
still be reported and erased if the switch is killed mid-rollout.

## Flow

1. **Intent** `POST /messages/photos` (client) or
   `POST /coach/clients/:client_id/messages/photos` (coach / assigned sub-coach)
   with `{ content_type, size_bytes }`. Checks: flag, type (JPEG/PNG/WebP;
   HEIC is refused because the phone converts to JPEG before upload), size
   (15 MB), thread tenancy, block either way, at most 30 unsent uploads per
   person. Creates a `pending` row with a server-minted staging key
   `<uploader>/staging/<photo_id>-<16 hex>` and returns a signed upload URL for
   that exact key. The window to finalize is 10 minutes (`expires_at`). The
   signed-upload token itself is Supabase's (about 2 hours); the row window is
   what the server enforces.
2. **Upload** the phone PUTs the bytes to the signed URL (private bucket
   `message-photos`, bucket-level 15 MB and type limits).
3. **Finalize** `POST .../photos/:photo_id/finalize`. The server claims the row
   (lease), downloads the raw upload, sniffs the real format (a renamed PDF or
   HEIC is rejected), strips metadata (`image-metadata.ts`: EXIF incl. GPS,
   XMP, IPTC, comments, JFIF thumbnails, multi-picture trailers; PNG text/eXIf
   chunks; WebP EXIF/XMP chunks), keeps only JPEG orientation, runs the
   moderation hook (`MESSAGE_PHOTO_SCANNER`), writes the clean copy to
   `<uploader>/<photo_id>-<16 hex>.<ext>` and erases the raw upload. Retries
   are safe: `upload_missing`, `storage_unavailable` and `processing` leave the
   row retryable; `rejected`, `not_an_image`, `type_unsupported`,
   `dimensions_out_of_range` are final.
4. **Send** `POST /messages` or `POST /coach/clients/:client_id/messages` with
   `photo_ids` (up to 10, display order). The message and its photo links are
   written in one transaction with conditional updates, so a photo is sent at
   most once.
5. **Read** thread lists carry `photos: [{ id, state, url, url_expires_at,
   width, height, content_type, position }]`. `url` is a 5-minute signed URL
   (`state: ready`) or null (`hidden`: the caller reported this message;
   `removed`; `unavailable`: storage could not sign). The full-screen viewer
   refreshes with `GET .../photos/:photo_id`. There is never a public URL.

## Removal and erasure

Every path records durable erasure work first (`message_photo_erasures`),
then marks the photo removed, then removes the object and verifies it is gone.
Storage faults leave open rows that the 10-minute sweep retries with backoff.

- Sender delete: `DELETE .../photos/:photo_id` (sender only, `not_sender` otherwise).
- Message delete: `MessagePhotosService.eraseForMessages(ids, 'message_deleted')`
  is the hook for the message delete path (lane A3). A message row that is
  hard-deleted (FK `ON DELETE SET NULL`) is caught by the sweep.
- Moderation: `PATCH /admin/message-photos/reports/:report_id { action: remove }`.
- Account deletion: `eraseMessagePhotosForAccount` runs in
  `finalizeUserDeletion` (step 10c): photos the user sent, photos in threads
  where the user is the client, and the user's whole folder.
- Unfinished uploads expire; finalized photos never sent are erased after 24 h.

## Moderation (report -> review -> action)

Members report the message with the existing `POST /messages/:id/report`. The
photo hides for the reporter at once (API and RLS). The TGP team reviews in
`GET /admin/message-photos/reports` (owner role; 15-minute review links,
`respond_by` 24 h, `overdue`) and acts with `remove` (erases every photo on the
message, closes all open reports on it) or `dismiss`. Both are audited.

## Security posture

- Bucket `message-photos` is private; a RESTRICTIVE fence on `storage.objects`
  keeps every RLS-bound role out (`verify.sql` proves it at release). The
  backend uses service_role.
- `message_photos` RLS: only thread parties read ready photos, unsent photos
  are the uploader's, blocked uploaders and reported messages are hidden;
  API roles cannot write. `message_photo_erasures` is deny-all for API roles.
- No classifier at launch (`NoopMessagePhotoScanner`, `scanner = 'none'` on
  each row). Photos are only visible inside a private 1:1 thread with an
  assigned coach; reports reach the TGP team queue.

## Known limits

- PNG and WebP orientation metadata is dropped with the rest (the mobile
  picker exports JPEG, which keeps orientation).
- Photos are not yet part of the data export (follow-up for the export lane).

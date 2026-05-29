/**
 * PR-12 — zod schemas for the coach-media endpoints.
 *
 * Body validation is intentionally NOT class-validator: same rationale as
 * package-contents.dto.ts (the global ValidationPipe with
 * forbidNonWhitelisted would strip unknown payload keys silently before
 * the controller saw them).
 */

import { z } from 'zod';

export const PDF_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const PDF_MIME_TYPES = ['application/pdf'] as const;

// Mux accepts a much larger ceiling, but we cap the coach-uploaded video
// size at 2 GB to keep the bill predictable. The Mux Direct Upload itself
// also has provider-side limits; this is an additional client-side hint
// only — Mux is the source of truth for actual size.
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB hint

export const TITLE_MAX_LEN = 200;
export const DESCRIPTION_MAX_LEN = 2000;

export const CreatePdfUploadSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LEN),
    description: z.string().max(DESCRIPTION_MAX_LEN).nullable().optional(),
    content_type: z.enum(PDF_MIME_TYPES).default('application/pdf'),
    byte_size: z
      .number()
      .int()
      .positive()
      .max(PDF_MAX_BYTES, { message: `PDF exceeds ${PDF_MAX_BYTES} byte cap` })
      .optional(),
  })
  .strict();

export const CreateVideoUploadSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LEN),
    description: z.string().max(DESCRIPTION_MAX_LEN).nullable().optional(),
    cors_origin: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const ConfirmPdfUploadSchema = z
  .object({
    byte_size: z.number().int().positive().max(PDF_MAX_BYTES).optional(),
    page_count: z.number().int().positive().optional(),
  })
  .strict();

export const PatchMediaSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX_LEN).optional(),
    description: z.string().max(DESCRIPTION_MAX_LEN).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreatePdfUploadInput = z.infer<typeof CreatePdfUploadSchema>;
export type CreateVideoUploadInput = z.infer<typeof CreateVideoUploadSchema>;
export type ConfirmPdfUploadInput = z.infer<typeof ConfirmPdfUploadSchema>;
export type PatchMediaInput = z.infer<typeof PatchMediaSchema>;

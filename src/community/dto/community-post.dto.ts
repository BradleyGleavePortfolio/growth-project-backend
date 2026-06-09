import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimOptional = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** POST /community/workspaces/:workspaceId/posts — create a Lab post. */
export class CreatePostDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'post title must not be empty' })
  @MaxLength(200, { message: 'post title must be 200 characters or fewer' })
  title!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'post body must not be empty' })
  @MaxLength(20000, { message: 'post body must be 20000 characters or fewer' })
  body!: string;
}

/** PATCH /community/posts/:postId — edit own post (no time limit). */
export class EditPostDto {
  @IsOptional()
  @Transform(trimOptional)
  @IsString()
  @MinLength(1, { message: 'post title must not be empty' })
  @MaxLength(200, { message: 'post title must be 200 characters or fewer' })
  title?: string;

  @IsOptional()
  @Transform(trimOptional)
  @IsString()
  @MinLength(1, { message: 'post body must not be empty' })
  @MaxLength(20000, { message: 'post body must be 20000 characters or fewer' })
  body?: string;
}

/** POST /community/posts/:postId/comments — top-level comment. */
export class CreateCommentDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'comment body must not be empty' })
  @MaxLength(2000, { message: 'comment body must be 2000 characters or fewer' })
  body!: string;
}

export class ListPostsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  before?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;
}

// ── Response schemas (Zod) ─────────────────────────────────────────────────

export const CommunityPostSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    cohort_id: z.string().uuid().nullable(),
    author_user_id: z.string().uuid(),
    title: z.string().nullable(),
    body: z.string().nullable(),
    scope: z.enum(['hall', 'cohort']),
    type: z.enum(['text', 'lesson', 'replay', 'poll', 'win']),
    pinned: z.boolean(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    deleted: z.boolean(),
  })
  .strict();

export type CommunityPostView = z.infer<typeof CommunityPostSchema>;

export const CommunityPostResponseSchema = z
  .object({ post: CommunityPostSchema })
  .strict();
export type CommunityPostResponse = z.infer<typeof CommunityPostResponseSchema>;

export const CommunityPostListResponseSchema = z
  .object({
    posts: z.array(CommunityPostSchema),
    next_before: z.string().nullable(),
  })
  .strict();
export type CommunityPostListResponse = z.infer<
  typeof CommunityPostListResponseSchema
>;

export const CommunityCommentSchema = z
  .object({
    id: z.string().uuid(),
    post_id: z.string().uuid(),
    author_user_id: z.string().uuid(),
    body: z.string(),
    created_at: z.string().datetime(),
  })
  .strict();

export type CommunityCommentView = z.infer<typeof CommunityCommentSchema>;

export const CommunityCommentResponseSchema = z
  .object({ comment: CommunityCommentSchema })
  .strict();
export type CommunityCommentResponse = z.infer<
  typeof CommunityCommentResponseSchema
>;

export const CommunityCommentListResponseSchema = z
  .object({ comments: z.array(CommunityCommentSchema) })
  .strict();
export type CommunityCommentListResponse = z.infer<
  typeof CommunityCommentListResponseSchema
>;

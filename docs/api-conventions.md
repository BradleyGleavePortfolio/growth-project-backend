# API conventions

## OpenAPI annotation convention

The repo publishes an OpenAPI 3.1 spec at `/docs-json` (Swagger UI at
`/docs`). The spec is generated from the controller and DTO classes by
`@nestjs/swagger`, which means **the spec is only as accurate as the
decorators on the source**.

### Rule

**Every new endpoint MUST be annotated with `@ApiOperation` and at least
one `@ApiResponse`.** Every new controller MUST carry an
`@ApiTags(...)` so its operations group correctly in Swagger UI.

This is non-negotiable — partner integrations and the auto-generated
SDKs read directly from the published spec, and an undocumented
endpoint is, in effect, an undocumented contract.

### What good looks like

```ts
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

@ApiTags('widgets')
@ApiBearerAuth('bearer')
@Controller('widgets')
export class WidgetsController {
  @ApiOperation({
    summary: 'Create a widget',
    description: 'Optional longer description for partners.',
  })
  @ApiResponse({ status: 201, description: 'Widget created.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @Post()
  create(@Body() body: CreateWidgetDto) { /* ... */ }
}
```

DTO fields used in request/response bodies should carry
`@ApiProperty` (or `@ApiPropertyOptional`) with at minimum a realistic
`example`. The auth and user-account DTOs are the reference for shape
and tone.

### Scope of existing annotations

Fully annotated:

- `src/auth/auth.controller.ts` + `src/auth/auth.dto.ts`
- `src/users/users.controller.ts`
- `src/health/health.controller.ts`

Tagged-only (group correctly in Swagger UI; per-endpoint summaries are
intentional follow-up): all other controllers under `src/`.

When you touch a tagged-only controller, **annotate the endpoints you
modify** so the spec gets richer over time. Don't leave
`@ApiOperation` off a new method even on a tagged-only file.

### Regenerating the static snapshot

```bash
npm run openapi:export
```

Writes `docs/openapi.json`. CI uses this for breaking-change diffs.

### Production gating

Docs are mounted only when `NODE_ENV !== 'production'` OR
`ENABLE_API_DOCS=true`. Production deploys are opt-in to keep internal
admin/coach surfaces from being published by default.

# Integration with Apps (Wave 6)

Wave 9 / Storefront. Status: DRAFT. Docs only.

This file specifies how a Wave 6 app declares a custom block, how the Storefront editor and public renderer load it, the iframe sandbox contract, the postMessage protocol, permission scopes, and failure modes. The Wave 6 app-manifest spec is the canonical reference for the manifest format itself; this file binds to it.

Companion files:
- `block-editor-spec.md` — block registry on host side; Section 18.15 registry hash.
- `block-types-catalog.md` — Section 14 Custom-Block.
- `funnel-analytics.md` — Section 2 `custom_block.event`.
- (External) Wave 6 spec — app manifest format.

---

## 1. The big picture

A Wave 6 app declares a `block` capability in its manifest. Once installed by a coach, the storefront editor exposes that block in the block-library side panel under "Apps". Coaches drag it onto their page; props are app-defined and validated against a manifest-supplied JSON Schema.

At public render time, the host page renders an `<iframe sandbox>` for each custom block. The iframe loads the app's URL with a signed JWT carrying:

- `pageId, versionId, blockId` (so the app knows where it lives)
- `coachId` (the storefront owner)
- `manifestId` (which app)
- `permissions: string[]` (subsetted scopes)
- `attributionToken` (forwarded from the visitor cookie if present)
- `mode: "preview" | "live"` (preview suppresses writes / external API calls)

The host enforces the iframe sandbox; the app cannot break out, escalate scopes, or read the surrounding page DOM.

---

## 2. Manifest contract

Sketch of the relevant subset (Wave 6 owns the full manifest):

```ts
interface AppManifest {
  manifestId: string;
  name: string;
  version: string;        // semver
  author: string;
  capabilities: {
    block?: BlockCapability;
    /* other Wave 6 capabilities — surface, action, ... */
  };
  declared_permissions: string[];
  // ... other fields
}

interface BlockCapability {
  /** Visible name in the block library. */
  displayName: string;
  /** Short description for the block library tile. */
  description: string;
  /** URL to load in the iframe. */
  iframeUrl: string;            // must be https
  /** JSON Schema for the props the block accepts. */
  propsSchema: object;
  /** Default props for new instances. */
  defaultProps: Record<string, unknown>;
  /** Initial size (server-side, for SSR placeholder). */
  defaultHeight: number;        // px
  /** Allowed permission scopes that the block can REQUEST. */
  permissionScopes: string[];
  /** Cap on how many instances per page. */
  maxInstancesPerPage?: number;
  /** Block icon for the library. */
  icon: string;                 // ImageRef
  /** Is this block mobile-friendly? */
  responsive: boolean;
}
```

Validation: `iframeUrl` must be https, must match the app's verified domain (Wave 6 verifies via DNS TXT). `propsSchema` must be a valid Ajv-compatible JSON Schema.

---

## 3. Editor-side flow

```
1. Coach opens editor.
2. Editor fetches the coach's installed apps (Wave 6 endpoint /api/apps/installed).
3. For each app with a `block` capability, the block library shows a tile.
4. Coach drags the tile onto a section.
5. Editor inserts a Custom-Block instance:
     {
       id: ULID,
       type: "custom-block",
       props: {
         __schemaVersion: 1,
         manifestId: "<from manifest>",
         appProps: <manifest.defaultProps>,
         permissions: <manifest.permissionScopes initially as recommended subset>
       },
       ...
     }
6. Inspector renders the app's prop fields based on manifest.propsSchema.
   - Type=string -> text or textarea
   - Type=number -> number
   - Type=enum -> select
   - Type=boolean -> toggle
   - Type=object/array -> nested form
7. Coach edits appProps; editor validates each keystroke against propsSchema.
8. Coach edits permissions checkboxes — can add/remove scopes within manifest.permissionScopes.
9. Autosave validates the full block:
     - manifestId installed for this coach
     - permissions ⊆ manifest.permissionScopes
     - appProps validates against manifest.propsSchema
     - block is responsive=true OR coach acknowledged the desktop-only warning
10. Editor canvas renders the block in a preview iframe (mode=preview).
```

---

## 4. Iframe sandbox contract

Both the editor preview iframe and the public renderer iframe use:

```html
<iframe
  src="<signed iframe URL>"
  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
  allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'"
  title="<manifest.displayName>"
  height="<manifest.defaultHeight>"
  width="100%"
></iframe>
```

Critical:
- `sandbox="allow-scripts allow-forms allow-popups allow-same-origin"` — `allow-same-origin` is required so the app can read cookies on its own domain (its session); we restrict cross-origin via CSP.
- No `allow-top-navigation` — the app can't navigate the host page.
- `Content-Security-Policy: frame-src` lists exactly the verified app domains.
- `allow=` denies sensor / payment APIs by default; manifest can opt-in (but must also be in the manifest's declared permissions and pass T&S review).

The app's URL receives a signed JWT in the query string `?context=<jwt>`. JWT shape:

```json
{
  "iss": "growthproject.app",
  "aud": "<manifestId>",
  "sub": "block:<blockId>",
  "exp": "<+5min>",
  "iat": "<now>",
  "claims": {
    "pageId": "...",
    "versionId": "...",
    "blockId": "...",
    "coachId": "...",
    "manifestId": "...",
    "permissions": ["..."],
    "attributionToken": "...",
    "mode": "preview" | "live",
    "visitorId": "...",
    "locale": "en-US"
  }
}
```

Signed with the platform's JWT key. The app verifies via JWKS at `https://growthproject.app/.well-known/jwks.json`.

The app MUST validate the JWT before doing anything trust-bearing. Wave 6 publishes a starter SDK that does this.

---

## 5. PostMessage protocol

After load, the app announces ready and the host responds with the page context (read-only). The protocol:

### 5.1 Host -> app messages

```ts
type HostToApp =
  | { kind: "host.ready"; protocolVersion: 1; context: ContextClaims }
  | { kind: "host.props.update"; props: Record<string, unknown> } // editor mode only
  | { kind: "host.height.acknowledged"; height: number }
  | { kind: "host.error"; code: string; message: string };
```

### 5.2 App -> host messages

```ts
type AppToHost =
  | { kind: "app.ready"; manifestId: string; protocolVersion: 1 }
  | { kind: "app.height.request"; height: number }
  | { kind: "app.event"; event: { name: string; payload: Record<string, unknown> } }
  | { kind: "app.cta.click"; href: string; label: string }
  | { kind: "app.error"; code: string; message: string };
```

### 5.3 Handshake

```
T+0ms        Host: <iframe src="...?context=<jwt>"></iframe>
T+200ms      App page loads; app code parses JWT.
T+250ms      App: postMessage { kind: "app.ready", manifestId, protocolVersion: 1 }
T+260ms      Host validates manifestId matches the JWT aud claim.
T+270ms      Host: postMessage { kind: "host.ready", protocolVersion: 1, context }
T+1s         App rendered; calls postMessage { kind: "app.height.request", height: 320 }.
T+1.01s      Host adjusts iframe height.
```

Timeout: if app doesn't `app.ready` within 5s, host shows fallback placeholder ("App `<name>` couldn't load").

### 5.4 Origin pinning

The host accepts postMessage only from the manifest's verified domain origin. Any message from a different origin is dropped silently and logged.

```js
window.addEventListener("message", (e) => {
  if (!verifiedOriginsForManifest(currentManifestId).has(e.origin)) return;
  // ... handle
});
```

### 5.5 Versioning

`protocolVersion: 1` is v1. The host supports the highest version it knows; if the app advertises a newer version, the host downgrades to its known maximum and informs the app. Apps must support graceful downgrade.

---

## 6. Permission scopes

Manifest declares permission scopes the block can request; the coach's editor lets them grant a subset.

Standard scopes:

| Scope                      | What it grants                                                |
|----------------------------|---------------------------------------------------------------|
| `read.coach.public`        | The app can read the coach's public profile (name, slug).     |
| `read.programs.public`     | The app can read the coach's public programs list.            |
| `read.cohorts.public`      | The app can read upcoming cohort dates.                       |
| `read.visitor.attribution` | The app receives the visitor's attribution token.             |
| `read.visitor.locale`      | The app receives the visitor's locale.                        |
| `emit.events`              | The app can emit `custom_block.event` to the analytics ledger.|
| `link.external`            | The app can render outbound links.                            |

NOT granted in v1 (any of these requires explicit T&S approval):

- `read.coach.private` — financial data, etc.
- `write.coach.*` — apps do not write coach data.
- `read.client.*` — apps cannot see clients of the coach.

The coach's permission UI in the inspector renders one checkbox per requested scope, default ON. Hover to see "what this allows". Unchecking a scope removes it from the JWT claims.

---

## 7. Renderer-side flow (public page)

```
1. Host SSR render encounters a custom-block.
2. Host renders an iframe placeholder with manifest.defaultHeight.
3. Iframe URL includes the signed JWT.
4. Browser loads the iframe lazily on intersection.
5. Inside iframe, app validates JWT, fetches its own data, renders.
6. App postMessages app.ready -> host responds with context.
7. App postMessages app.height.request -> host adjusts.
8. User interactions inside iframe stay inside iframe; CTAs the app wants tracked are emitted via app.cta.click and app.event messages, which the host relays to the analytics ingestion endpoint.
```

The host wraps the app's CTA emissions with the host's visitor context (visitorId, sessionId) and treats them as `cta.click` events with `{ blockId, source: "custom_block" }`. The app cannot fabricate visitor context — it only emits its own event payloads, the host attaches the visitor identity.

---

## 8. Failure modes

### F-Apps-1: Block load timeout

- Detection: app doesn't `app.ready` within 5s.
- Public-render recovery: replace iframe with a styled placeholder `<div>App <name> unavailable.</div>`. Page render is not blocked.
- Editor recovery: same; allow coach to remove the block.
- Audit: `editor.custom_block.load_fail { pageId, blockId, manifestId, reason: "timeout" }`.
- Telemetry: `custom_block.load_fail` count by manifestId — surfaces problematic apps to the SREs.

### F-Apps-2: Oversized payload

- Detection: app posts `app.event` with payload > 8KB.
- Recovery: drop the event, post `host.error { code: "PAYLOAD_TOO_LARGE" }` to the iframe. Persist no row in BlockEvent.
- Audit: `custom_block.payload_oversized { manifestId, blockId, bytes }`.

### F-Apps-3: Untrusted origin postMessage

- Detection: postMessage from origin not on manifest verified-domains list.
- Recovery: drop silently. Log to Sentry under `custom_block.untrusted_origin` (deduplicated by origin to avoid log noise).
- This catches: a malicious site iframe-ing the storefront and trying to spoof messages, OR a manifest that adds a domain without verification.

### F-Apps-4: Version mismatch

- Detection: app advertises `protocolVersion > host.protocolVersion`.
- Recovery: host responds with its supported version; app must downgrade. If app cannot downgrade, app posts `app.error { code: "VERSION_INCOMPATIBLE" }`; host shows fallback.
- Audit: `custom_block.version_mismatch { manifestId, hostVersion, appVersion }`.

### F-Apps-5: Sandbox break attempt

- Detection: postMessage with `kind` outside the AppToHost union, OR `app.event.name` matching a known dangerous pattern (e.g. trying to fake `application.submit`).
- Recovery: drop, log, mark the manifest as "review pending"; T&S notified.
- Hard policy: an app that repeatedly triggers this is auto-disabled platform-wide pending review.

### F-Apps-6: JWT replay

- Detection: same JWT presented twice within its `exp` window. (We don't try to detect this; JWTs are short-lived — 5 min.)
- Recovery: not actually a problem at scale because the JWT only identifies the visitor and the block; replaying it gets the same context, no escalation.

### F-Apps-7: App returns 5xx

- Detection: iframe's HTTP response is 5xx.
- Recovery: same as load timeout — fallback placeholder.

### F-Apps-8: Manifest disabled mid-render

- Detection: page's tree references a manifestId that's been disabled/uninstalled since the publish.
- Recovery: render placeholder "App <name> not installed." Editor surfaces a banner on next open: "Re-add or remove the disabled app block."

---

## 9. Editor preview vs. public render

Both modes use the same iframe contract. Differences:

| Concern                  | Editor preview (`mode=preview`) | Public render (`mode=live`) |
|--------------------------|---------------------------------|-----------------------------|
| Visitor id               | Editor's session id             | Visitor cookie ULID         |
| Attribution token        | None                            | From cookie                 |
| Analytics events         | NOT emitted                     | Emitted to ingest endpoint  |
| External writes          | NOT allowed (per host policy)   | Allowed if scopes granted   |
| Editor `props.update` postMessage | Sent on every edit       | NOT sent (props frozen at publish) |

Apps must respect `mode` and behave accordingly. The starter SDK exposes `context.mode === "preview"` as a flag.

---

## 10. App provisioning lifecycle

```
1. App developer publishes a manifest (Wave 6 dev portal).
2. Manifest goes through T&S review.
3. Approved manifests appear in coach app marketplace.
4. Coach installs the app.
5. App's block becomes available in the coach's editor block library.
6. Coach drags + configures a Custom-Block instance.
7. Coach publishes the page.
8. Live storefront includes the iframe.
9. Visitor sees the rendered block.
10. Coach receives analytics for it (block.impression, custom_block.event, etc).
```

If the app is uninstalled (post-publish), live pages serve placeholder until the coach re-publishes without it.

If a manifest version bumps (`v1.0.0` -> `v1.1.0`), the iframe loads the new version on next render. If the new version's `propsSchema` is incompatible with stored `appProps`, the host renders a placeholder "App <name> v1.1 needs reconfiguration"; editor shows a re-config flow. T&S guideline to manifest authors: try not to break existing pages.

---

## 11. Performance budgets

| Metric                                | Budget           |
|---------------------------------------|------------------|
| Iframe TTI (within iframe)            | <= 1s p95        |
| Iframe-to-host first-paint impact     | <= 0 (lazy load) |
| postMessage latency                   | <= 16ms p95 (1 frame) |
| App handshake completion              | <= 2s p95        |
| Custom-block load failure rate        | <= 0.5% / 24h    |

If any single app exceeds the load failure rate, T&S is auto-notified and the app may be soft-disabled.

---

## 12. Security and audit

```
custom_block.iframe.loaded         { manifestId, blockId, pageId, durationMs }
custom_block.iframe.failed         { manifestId, blockId, pageId, code, message }
custom_block.event.received        { manifestId, blockId, pageId, eventName, payloadBytes }
custom_block.event.rejected        { manifestId, blockId, code, reason }
custom_block.untrusted_origin      { origin, manifestId? }
custom_block.payload_oversized     { manifestId, blockId, bytes }
custom_block.version_mismatch      { manifestId, hostVersion, appVersion }
custom_block.permission.granted    { coachId, manifestId, scopes }
custom_block.permission.revoked    { coachId, manifestId, scopes }
```

All entries include `requestId, occurredAt`. Sampling at 10% for `event.received` (high volume); 100% for the rest.

---

## 13. Test plan

- Unit: JWT signing/verification fixtures.
- Integration: a stub app that handshakes, requests height, emits an event; assert iframe size adjusts and event ingests.
- Negative: stub app that posts from a different origin; assert message dropped.
- Negative: stub app that posts oversized event; assert dropped + log.
- Load: 1000 concurrent custom-block iframes on synthetic pages; host-side memory and latency stable.
- Security: T&S checklist — sandbox attrs correct, CSP frame-src enforced, no allow-top-nav.

---

## 14. Senior-engineer onboarding checklist

- [ ] Read this file end-to-end.
- [ ] Read Wave 6 manifest spec.
- [ ] Run `pnpm storefront:custom-block:stub` to spin up a local stub iframe.
- [ ] Inspect the JWT issued in dev mode.
- [ ] Read the host's `<iframe>` render code.

---

## 16. Worked end-to-end example

A coach installs the "Loom Reviews" app. The manifest declares a block:

```json
{
  "manifestId": "loom-reviews",
  "name": "Loom Reviews",
  "version": "1.2.0",
  "author": "Loom Inc.",
  "capabilities": {
    "block": {
      "displayName": "Loom Video Reviews",
      "description": "Embed video reviews from your Loom workspace.",
      "iframeUrl": "https://embed.loom.com/storefront/reviews",
      "propsSchema": {
        "type": "object",
        "required": ["workspaceId", "limit"],
        "properties": {
          "workspaceId": { "type": "string" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 12 },
          "layout": { "enum": ["carousel", "grid"] }
        }
      },
      "defaultProps": { "workspaceId": "", "limit": 6, "layout": "grid" },
      "defaultHeight": 480,
      "permissionScopes": ["read.coach.public", "emit.events"],
      "icon": { "imageId": "img_LOOM_ICON", "alt": "Loom" },
      "responsive": true
    }
  },
  "declared_permissions": ["read.coach.public", "emit.events"]
}
```

Coach drags it onto their page and configures `workspaceId`. The block is autosaved as:

```json
{
  "id": "01HXBLOCK_LOOM",
  "type": "custom-block",
  "props": {
    "__schemaVersion": 1,
    "manifestId": "loom-reviews",
    "appProps": { "workspaceId": "ws_abc", "limit": 6, "layout": "grid" },
    "permissions": ["read.coach.public", "emit.events"]
  },
  "visibility": { "mobile": true, "tablet": true, "desktop": true },
  "editScopeTag": null,
  "analytics": true
}
```

On publish, the public renderer emits:

```html
<iframe
  src="https://embed.loom.com/storefront/reviews?context=eyJhbGciOi...JWT..."
  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
  height="480"
  width="100%"
  loading="lazy"
  title="Loom Video Reviews"
></iframe>
```

The iframe loads, validates the JWT, fetches the workspace's videos via Loom's API, renders. It posts `app.ready`, then `app.height.request` (height adjustment), then per-video `app.event { name: "loom.video.play" }`.

The host receives the events, attaches visitor context, persists as `custom_block.event` with `payload: { name: "loom.video.play", ... }`. Coach's analytics dashboard shows "Loom Video Reviews block: 87 impressions, 42 video plays".

---

## 17. CSP composition for custom blocks

Per-page CSP is composed at render time:

```
frame-src 'self'
  https://www.youtube.com
  https://player.vimeo.com
  ... (allowlisted embeds)
  https://embed.loom.com    <- added by virtue of the loom-reviews block being present
  https://app.example.com   <- added by virtue of another custom block
```

Non-present custom block hosts are NOT in the CSP — tighter is better. The renderer collects all custom-block manifestIds, looks up each manifest's verified-domain list, unions into `frame-src`.

If a manifest changes its verified domains post-publish, the live page's CSP is stale until the next publish. This is acceptable; the iframe still loads from its own URL, just enforced against the older allowlist.

---

## 18. Permission revocation flow

If a coach removes a scope via the inspector, autosave removes it from `permissions[]`. On next publish, the JWT minted for the iframe omits that scope. The app sees `claims.permissions` and adapts (e.g. doesn't request the visitor's locale anymore).

If the manifest itself revokes a scope (manifest update), all live pages serving that block get the new scope set on next iframe load — the JWT mint always intersects coach-granted with manifest-declared.

Scope revocation never re-publishes the page. The signed JWT is minted fresh on every iframe load, drawing from the current authoritative scope set.

---

## 19. App developer expectations

Apps that ship as custom blocks must:

- Validate the JWT before doing anything trust-bearing.
- Respect `mode === "preview"` (no external writes, no analytics emission).
- Handle `protocolVersion` downgrade.
- Fail gracefully if scopes are missing.
- Stay within their stated `defaultHeight` band most of the time; height adjustments allowed but should not flicker.
- Not assume any DOM access outside the iframe.
- Not assume any cookie access outside their own origin.
- Be reasonable about external network calls — the host is not a CDN for the app.

A starter SDK (Wave 6 deliverable) handles JWT verification, postMessage handshake, and the AppToHost message type-safety. App developers should use it.

---

## 20. Cross-repo handshakes

- Wave 6 owns: manifest format, manifest verification (DNS TXT for domains), app marketplace, JWT signing keys / JWKS endpoint, starter SDK.
- Wave 9 (this) owns: iframe rendering, postMessage relay, scope subset UI, custom-block analytics ingestion.
- Wave 7 owns: attribution token; Wave 9 forwards.

Implementation coordination: the manifest's `iframeUrl` host MUST match a domain that Wave 6 has DNS-verified for the manifest. Wave 9 assumes Wave 6's verification; trust-on-first-render but validation happens at the manifest-publish step.

---

## 21. Custom-block height behaviour

Apps frequently render dynamic-height content. The protocol:

- App posts `app.height.request { height: <new> }` whenever its content size changes.
- Host adjusts iframe height; host responds with `host.height.acknowledged { height: <applied> }` so the app can layout accordingly.
- Host has a max height cap of 4000px; requests above are clamped.
- Host has a min height of 80px.
- Host applies a 100ms debounce to avoid layout thrash on rapid height changes.

Coach can override the default height via the inspector's "Block height" field; in that case, the host caps app.height.request at the coach-set value (so an app can't grow without bound and break the coach's layout intent).

---

## 22. Failure-mode coverage table

| Code        | Mode                      | Detection            | Recovery                      |
|-------------|---------------------------|----------------------|-------------------------------|
| F-Apps-1    | load timeout              | 5s no app.ready      | placeholder                   |
| F-Apps-2    | oversized payload         | > 8KB                | drop event, error msg         |
| F-Apps-3    | untrusted origin          | origin mismatch      | drop silent                   |
| F-Apps-4    | version mismatch          | protocolVersion gap  | downgrade or placeholder      |
| F-Apps-5    | sandbox break attempt     | unknown message kind | drop, log, T&S notify         |
| F-Apps-6    | JWT replay                | (not detected — short-lived) | n/a                  |
| F-Apps-7    | app 5xx                   | iframe load error    | placeholder                   |
| F-Apps-8    | manifest disabled         | render-time check    | placeholder, banner in editor |

---

## 23. Audit log entries (recap)

```
custom_block.iframe.loaded         { manifestId, blockId, pageId, durationMs }
custom_block.iframe.failed         { manifestId, blockId, pageId, code, message }
custom_block.event.received        { manifestId, blockId, pageId, eventName, payloadBytes }
custom_block.event.rejected        { manifestId, blockId, code, reason }
custom_block.untrusted_origin      { origin, manifestId? }
custom_block.payload_oversized     { manifestId, blockId, bytes }
custom_block.version_mismatch      { manifestId, hostVersion, appVersion }
custom_block.permission.granted    { coachId, manifestId, scopes }
custom_block.permission.revoked    { coachId, manifestId, scopes }
custom_block.manifest.disabled     { manifestId, byUserId, reason }
custom_block.scope.intersected     { coachId, manifestId, requested, granted, intersection }
```

---

## 24. Notes for T&S review

- Each manifest goes through Wave 6 T&S; this document does not duplicate that.
- Wave 9 adds: scope-subset UX, height clamping, sandbox enforcement, untrusted-origin filtering. T&S signs off on these as part of the Wave 9 launch.
- Subsequent manifest reviews should check that the iframeUrl host is HTTPS, on a verified domain, and that `propsSchema` doesn't include obvious data-exfil fields (e.g. don't accept the visitor's email as a prop).

---

## 25. Open questions

None unresolved beyond OWNER decisions in README.

End of integration-with-apps.


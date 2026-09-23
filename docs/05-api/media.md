# AfriLink Media Storage + API Architecture

**Status:** DESIGN ONLY — proposed for owner review. No package has been installed, no controller/service/DTO/worker/S3-client code has been written, and no dependency has been added to any `package.json`. `database/schema.prisma` and the applied Media migration (`20260922093956_add_media`, commit `a546c34`) are unmodified by this document.
**Date:** 2026-09-22
**Builds on, does not redesign:** `docs/04-database/media.md` (the approved Media database design — every field, state, and retention rule below is a restatement or an API-level extension of that document, never a change to it), `architecture.md` §16, `api.md` §15–17, ADR-002 §7 (approval-gate.md), `docs/05-api/messaging-websocket.md` (structural precedent for this kind of design-first, dependency-verified document)

> Sections below describe the proposed design. Nothing in this document is implemented. Where a decision genuinely cannot be resolved from an approved document, it is marked **OPEN DECISION** rather than silently chosen.

---

## 1. Media API contract

Extends `api.md` §15's already-approved Media row (`REST, signed upload flow, /media/uploads, /media/{id}, Owner-authorized, N/A pagination`) into four concrete routes. No route beyond what that contract already implies is proposed — in particular, no `GET /media` list route (§15 marks pagination "N/A," i.e. single-resource reads only) and no separate "status" route (state is part of the metadata response, §1.3).

All four follow the codebase's existing conventions unchanged: the `{data: ...}` / `{error: {code, message, details?, requestId}}` envelope (`api.md` §6), `JwtAuthGuard` + `CsrfGuard` on every state-changing route, `ParseUuidPipe` on every UUID path parameter (to be added to the path-params completeness guard when implemented, per the T-1 convention), and the same 404-regardless-of-reason rule used everywhere (`api.md` §6: never disambiguate *why* a resource is unreachable).

### 1.1 `POST /media/uploads` — initialize an upload

| | |
|---|---|
| **Auth** | `JwtAuthGuard`, `CsrfGuard` |
| **Authorization** | Any authenticated user, for themselves only. `ownerUserId` is never a request field (mass-assignment protection, `api.md` §17) — it is always the caller. |
| **Request** | `{ kind: 'image' \| 'video', purpose: 'avatar' \| 'cover' \| 'post' \| 'message_attachment', declaredMimeType: string, declaredByteSize?: number, declaredChecksum?: string }` |
| **Validation** | `kind`/`purpose` against the approved allowlists (`media.md` §3); `declaredMimeType` against a per-`(kind, purpose)` MIME allowlist (exact list: **OPEN DECISION**, §13); `declaredByteSize` a positive integer under a configurable ceiling (exact ceiling: **OPEN DECISION**, §13); `purpose`+`kind` pair checked against `media.md` §3's table (e.g. `purpose=avatar` with `kind=video` is rejected) |
| **Response `201`** | `{ data: { assetId, uploadId, uploadUrl, uploadFields?, expiresAt } }` — a presigned PUT (or POST-policy) target scoped to exactly one object key and one HTTP method |
| **Errors** | `401` no session · `403` no/bad CSRF token · `422 VALIDATION_FAILED` bad `kind`/`purpose`/MIME/size · `422 POLICY_REJECTED` disallowed `(kind, purpose)` pair |
| **Lifecycle** | Creates `Asset` (`state=pending`, `scanState=pending`, `moderationState=active`) and `Upload` (`status=reserved`, `expiresAt` = now + the upload-expiry window, §13 open item) in one transaction. Nothing is uploaded yet. |
| **Idempotency** | **Not idempotent.** Each call creates a new pending `Asset`+`Upload`. A client retry after a network failure produces a second reservation, not an error — the abandoned first one is caught by the M-1 cleanup job (`media.md` §14) once implemented. No client-supplied idempotency key is proposed (unlike `Message.clientMessageId`): duplicate reservations are bounded, self-cleaning junk, not a correctness risk. |

### 1.2 `POST /media/uploads/{uploadId}/complete` — finalize

| | |
|---|---|
| **Auth** | `JwtAuthGuard`, `CsrfGuard` |
| **Authorization** | Caller must own the `Upload` row (`uploads.owner_user_id = caller`) — `404`, not `403`, if not owned or not found. |
| **Request** | `{}` — empty. The client is signaling "I believe the upload finished," nothing more; nothing it says here is trusted as final (the worker verifies authoritatively, §6). |
| **Response `200`** | `{ data: { assetId, state: 'processing' } }` |
| **Errors** | `401` · `403` (CSRF) · `404` not found/not owned · `422 POLICY_REJECTED` if `Upload.status` is already `expired` or `failed` (a dead reservation cannot be completed) |
| **Lifecycle** | `Upload.status: reserved → completed` (sets `completedAt`); `Asset.state: pending → processing`. Enqueues async processing via the **existing** `integration.outbox_events` mechanism (`database.md` §15) — no new queue/job dependency, matching architecture.md's established "async where appropriate" pattern. Does not itself validate, scan, or generate variants. |
| **Idempotency** | **Idempotent.** Calling `complete` again while `status=completed` is a no-op `200` returning the current state (matches the repeat-call-is-a-no-op convention already used throughout Communities — join, approve, leave). |

### 1.3 `GET /media/{assetId}` — metadata + authorized access

| | |
|---|---|
| **Auth** | `JwtAuthGuard` (never optional — `api.md` §15 says Media is "Owner-authorized," not public) |
| **Authorization** | Owner-only (`assets.owner_user_id = caller`). **This is deliberately narrower than "can view the post/profile this is attached to."** See §7 for why: attachment-context viewing (seeing an image *inside* a post/profile/message you're already authorized to see) is served by that owning module's own response embedding a resolved URL — not by calling this route. This route is the owner's own management/status view of their asset. |
| **Response `200`** | `{ data: { id, kind, purpose, state, scanState, moderationState, declaredMimeType, verifiedMimeType, byteSize, widthPx, heightPx, durationSeconds, createdAt, updatedAt, readyAt, rejectedAt, variants: [{ variantName, url, mimeType, widthPx, heightPx, durationSeconds, byteSize }] } }` — `variants` includes only `state=ready` rows; each `url` is a **freshly generated, short-lived signed GET URL, never stored, regenerated on every request** (`media.md` §11). `storageKey`/`storageProvider`/`checksum` are never returned. |
| **Errors** | `401` · `404` not found, not owned, or soft-deleted (identical response in all three cases) |
| **Lifecycle** | Pure read. No state change. |
| **Idempotency** | N/A (read-only). |

### 1.4 `DELETE /media/{assetId}` — delete

| | |
|---|---|
| **Auth** | `JwtAuthGuard`, `CsrfGuard` |
| **Authorization** | Owner-only, `404` otherwise |
| **Response `200`** | `{ data: { deleted: true } }` |
| **Errors** | `401` · `403` (CSRF) · `404` not found/not owned/**already deleted** — matches the Communities precedent exactly (`DELETE /communities/{id}`: "row kept, second delete is 404"), not an idempotent-200-on-repeat pattern |
| **Lifecycle** | Soft delete only (`deletedAt` set). Immediately makes the asset non-servable (§1.3's read rule already excludes soft-deleted assets). **Does not** remove any `PostMedia`/`MessageAttachment` row or clear `avatarMediaId`/`coverMediaId` — de-referencing the attachment is the owning module's own future edit-flow responsibility (removing an image from a post is Content's job, matching "each module owns its business rules"), not something Media reaches into another module's tables to do. Hard purge follows the approved 7-day/90-day retention rules (§10). |
| **Idempotency** | Not idempotent in the sense of a repeat 200 — matches the existing Communities delete precedent (404 on repeat), which itself functions as idempotent-*intent* (the end state, "gone," is reached either way; only the response code differs on repeat). |

**Deliberately not proposed:** a list/browse endpoint (`api.md` §15 marks Media's pagination "N/A"); a separate status-polling route (state is already in §1.3); any endpoint that lets a caller name another user as `ownerUserId` or attach an asset to content directly (attachment happens through each owning module's own endpoint, §7).

---

## 2. Storage architecture — component responsibilities

Restates and extends `architecture.md` §16's six-step pipeline with an explicit **never** list per component, since "what must never happen" is the actual security boundary, not just the happy path.

| Component | Must | Must **never** |
|---|---|---|
| **API** | Authorize owner/purpose/kind/size; create the pending `Asset`+`Upload` row; generate a presigned upload target scoped to one key and one method; verify ownership on every subsequent call; generate fresh signed GET URLs per read, never persisted | Accept raw file bytes in a request body (no multipart-through-the-API — that defeats the direct-to-storage design and puts file bandwidth/memory load on the API tier); serve an unsigned or permanent URL; trust any client-declared fact (MIME, size, checksum) as authoritative; skip the ownership check because the caller already knows a valid `assetId` |
| **PostgreSQL** | Store metadata/state only, as the sole source of truth for what an asset *is* (`media.md` §9) | Store binary bytes; store a public/provider URL as the authority — `storageKey` is a private, internal reference only |
| **Object storage** | Hold binaries under a private (non-public-read) bucket policy; serve only signed requests | Be publicly listable or readable without a signed request; be trusted as a source of metadata truth — dimensions/duration/checksum live in Postgres once verified, never re-derived from storage on every read |
| **Processing worker** *(future — not built this phase, §6)* | Consume the completion signal; fetch the object; verify type/size/checksum/dimensions/duration; scan where available; strip unsafe metadata; generate variants under new keys; write `Variant` rows; update `Asset.state`/`scanState` | Trust the declared MIME/size; mark `state=ready` without at least one `Variant` row existing; write a raw client-uploaded file directly as a servable variant (every servable representation is worker-produced, `media.md` §6) |
| **Client** | Upload directly to the signed target; call `complete`; poll `GET /media/{id}` for readiness | Be given direct storage credentials (only ever a scoped, short-lived signed URL); choose the storage key; see the raw `storageKey`/provider beyond what the signed PUT itself requires |

---

## 3. Storage provider — architecture-level, vendor-neutral

**No vendor is selected here.** ADR-002 §13 explicitly defers vendor/region selection to the deployment/infrastructure phase; this section evaluates only the **client library** needed to speak the S3-compatible protocol against whichever provider is eventually chosen — and confirms that choosing a widely-adopted client does not itself amount to vendor selection.

### Required S3-compatible operations
`PutObject`/presigned-PUT (or multipart, for larger video), `GetObject`/presigned-GET, `DeleteObject`, and presigning support for both. `HeadObject` optionally, for an API-side sanity check at completion time (not required — the worker is the authoritative verifier).

### Signed URL / presigned request requirements
Every request is scoped to exactly one object key and one HTTP method, short-lived (exact TTLs: **OPEN DECISION**, §13), and — for reads — generated fresh per `GET /media/{id}` call, never cached or stored (`media.md` §11).

### Private bucket/object assumptions
No public-read bucket policy anywhere. Every object access, upload and download, goes through a signed request. This is a hosting-account configuration requirement for whichever vendor is chosen, not something this design can enforce from application code alone — flagged so it isn't missed at the vendor-setup step.

### Object key strategy
Derived entirely from `Asset.id`, **never** from a client-supplied filename (`architecture.md` §16 / PRD §31: "never trust filenames"): `media/{ownerUserId}/{assetId}/original` for the asset's own private object, `media/{ownerUserId}/{assetId}/variants/{variantName}` for each generated variant. Owner-partitioned (not date-partitioned) — this matches the access pattern privacy/retention work actually needs ("find and remove everything this user owns"), which date-partitioning wouldn't serve as directly.

### Upload expiry / deletion / metadata handling
Expiry: short, matching "short-lived signed instructions" (`architecture.md` §16); exact minutes — **OPEN DECISION** (§13), distinct from the already-approved *downstream* 7-day/48-hour cleanup windows (`media.md` §14), which govern what happens *after* something expires, not how long it's valid for. Deletion: `DeleteObject` is called only by the future retention job (§10), never from a live request path, for the asset's own key and every variant key. Metadata: object-storage-native metadata/tags are not used as a system of record (Postgres is authoritative, `database.md` §3) — setting a correct `Content-Type` on `PutObject` is a reasonable implementation nicety, not a design requirement.

### Candidate client libraries (comparison, not selection)

| | A. `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | B. `minio` (official MinIO client) | C. Hand-rolled SigV4 signing |
|---|---|---|---|
| Protocol coverage | Full S3 API surface, presigning included | S3-compatible surface, presigning included | Whatever is hand-implemented |
| Provider-neutral despite the name? | **Yes — verified live against three independent providers' own docs**, not assumed: Cloudflare R2's docs literally say *"JavaScript or TypeScript users may continue to use the `@aws-sdk/client-s3` npm package"*; DigitalOcean Spaces' docs show `npm install @aws-sdk/client-s3` as their own setup step; MinIO is S3-protocol-compatible by design. The package name reflects the protocol it was first published for, the same way this project's existing `pg` dependency isn't "vendor lock-in to a specific Postgres host." | Yes, MinIO-maintained but documented to work with AWS S3 and other S3-compatible services too — more MinIO-flavored API shape (bucket/object-centric) than AWS's broader SDK shape | Yes, trivially — but reimplements a well-known, easy-to-get-subtly-wrong signing scheme for no stated benefit |
| Node requirement (verified live against npm registry, not assumed) | `>=20.0.0` (both packages, version `3.1137.0`) | `^16 \|\| ^18 \|\| >=20` (version `8.0.7`) | N/A |
| Node 24.21.0 (this project) | ✅ satisfied | ✅ satisfied | N/A |
| CJS/ESM compatibility with this project (`services/api`: `"module": "commonjs"`, no `"type": "module"`) | **Dual-published** — verified live: `package.json` carries both `"main": "./dist-cjs/index.js"` and `"module": "./dist-es/index.js"`. Zero friction with the current CommonJS build. | Not verified this session — flag before adopting | N/A |
| Community/maintenance signal | Official AWS SDK, the de facto standard for S3-protocol access in Node | Official MinIO project, smaller adoption for non-MinIO targets | None — self-maintained |
| Bundle footprint | Two packages, modular (only the S3 client + presigner, not the full multi-service SDK) | One smaller package | Zero dependencies, but real engineering cost to write and maintain correctly |

**Recommendation:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — not a vendor choice, a protocol-client choice, and the one every S3-compatible provider likely to be evaluated at the deployment phase already documents as its own supported path. Nothing is installed here; this is the recommendation for when §4's dependency gate is actually authorized.

---

## 4. Dependency gate

**For this phase (API + storage-client wiring only — not the processing worker):**

| Package | Exact version (verified live, npm registry) | Purpose | Required/Optional | Node 24.21.0 compat | Needed for local dev | Could an existing dependency avoid it? |
|---|---|---|---|---|---|---|
| `@aws-sdk/client-s3` | `3.1137.0` | S3-compatible operations (Put/Get/Delete/Head, presign target) | Required | ✅ (`>=20.0.0`) | Yes — same client talks to a local MinIO instance or a real provider, only `endpoint`/credentials differ | No — `pg`/`@prisma/client` don't speak the object-storage protocol; nothing existing covers this |
| `@aws-sdk/s3-request-presigner` | `3.1137.0` | Generates the presigned PUT (upload) and GET (read) URLs `client-s3` alone doesn't produce | Required (pairs with the above) | ✅ | Yes | No |

**Explicitly not proposed this phase** (belongs to the processing-worker phase, §6, not yet authorized):
- An image-processing library (e.g. `sharp`) and a video-processing wrapper (e.g. an `ffmpeg` binding) — needed only once variant *generation* is built, not for upload/API wiring.
- `file-type` (magic-byte MIME sniffing, for the worker's "never trust the declared MIME" verification) — checked live for completeness: version `22.1.1`, requires Node `>=22` (satisfied), but is **ESM-only** (`"type": "module"`, no CommonJS entry) — would need dynamic `import()` inside this CommonJS project, a real integration cost to flag when that phase is proposed, not now.

**No existing package version is proposed for upgrade or downgrade.** `@prisma/adapter-pg`/`pg`/`@prisma/client` in `services/api`/`database` are untouched by this proposal — the S3 client is fully independent of the Postgres stack.

---

## 5. Upload security

- **Ownership verification:** every route re-checks `ownerUserId`/caller identity per-request (§1); nothing is cached from a prior response (`api.md` §17's IDOR rule, applied here).
- **Allowed MIME types:** a `(kind, purpose)`-scoped allowlist, checked at `POST /media/uploads` against the *declared* type (a first-pass, non-authoritative filter — the worker's verified type is what actually gates `ready`, §6). Exact list: **OPEN DECISION** (§13).
- **Maximum size enforcement:** checked at initialization against the *declared* size (non-authoritative), and again by the worker against the *actual* downloaded object (authoritative) — a declared-size lie only wastes a rejected upload, never produces a `ready` asset. Exact ceiling: **OPEN DECISION** (§13).
- **Upload expiry:** both the signed URL itself and the `Upload.expiresAt` reservation are short-lived; an expired-but-uncompleted reservation can never be completed (§1.2's `422 POLICY_REJECTED`) and is caught by the M-1 cleanup job.
- **Object-key generation:** always server-derived from `Asset.id` (§3) — the client never supplies or influences the key.
- **Filename handling:** a client-supplied filename, if ever collected for display purposes (e.g. "you uploaded `photo.jpg`"), is stored as opaque display text only, never used to derive a path, extension-sniff a type, or influence the storage key — the same "never trust filenames" rule applies to display metadata as to security decisions.
- **Path traversal prevention:** not applicable to the object key itself (server-derived, §3, no user input reaches it) — relevant only if a filename is ever displayed back to the user, which must be escaped/encoded like any other user text, not interpreted as a path.
- **Spoofed MIME protection:** the declared MIME is a UX hint only; the worker's verified type (magic-byte inspection, §6) is what gates `ready` — matches `media.md` §3's `declaredMimeType`/`verifiedMimeType` split exactly.
- **Checksum handling:** optional client-declared checksum (fast client-side pre-check) vs. worker-computed checksum (authoritative, stored on `Asset`/`Variant`) — same declared-vs-verified split.
- **Unpublished/pending asset access:** `GET /media/{id}` is owner-only regardless of `state` (§1.3) — a non-ready asset is never exposed through any *other* surface either, since attachment-context viewing (§7) only ever resolves `ready` variants.
- **Signed URL lifetime:** short for both upload (PUT) and read (GET); read URLs are generated fresh per request, never stored or reused past their TTL (§1.3, `media.md` §11).
- **Replay considerations:** a leaked upload URL is scoped to one object key and expires quickly — worst case, an attacker could upload *something* to that one pre-authorized key before expiry, but the worker's own validation (type/size/scan) still gates whether that object ever becomes `ready`, and the asset is owned by whoever initialized it, not whoever performed the PUT — no privilege is gained. A leaked *read* URL exposes that one variant until its own short TTL lapses; regenerating per request bounds this window tightly.
- **Authorization at completion:** `POST /media/uploads/{uploadId}/complete` re-checks ownership of the `Upload` row (§1.2) — a client cannot complete someone else's reservation even if it somehow learns the `uploadId`.

---

## 6. Processing pipeline — future boundary only, not implemented

Restates `media.md` §3/§6/§9's already-approved shape as an explicit worker-responsibility boundary, distinguishing the three axes the task asks to be kept separate:

| | **Database state** (`Asset.state`) | **Processing state** (`Asset.scanState` + variant generation progress) | **Moderation state** (`Asset.moderationState`) |
|---|---|---|---|
| What it answers | Where is this asset in its lifecycle? | Has it passed the pre-publish automated safety check, and do ready variants exist yet? | Has Moderation acted on an *already-published* asset? |
| Values | `pending → processing → ready \| rejected` | `scanState`: `pending/passed/failed/skipped`; variants each carry their own `pending/ready/failed` | `active/hidden/removed` |
| Who transitions it | API (`pending`, via §1.1/§1.2) and the worker (`processing → ready\|rejected`) | The worker only | Moderation module (not built) — out of scope here, same as every other module's moderation hook |
| Gates what | Whether the asset is referenceable at all (§1.3, §7) | Whether `state` may become `ready` | Whether an already-`ready` asset stays visible without being deleted |

**Worker responsibilities (design only, no code):** image validation (dimensions, actual vs. declared MIME via magic-byte sniffing, corruption checks); video validation (duration, dimensions, container/codec sanity); checksum computation (authoritative, written to `Asset`); malware/security scanning "where available" (`architecture.md` §16 — provider unselected, same vendor-neutral deferral as storage); metadata stripping (EXIF/GPS and similar unsafe embedded metadata, before any variant is generated); variant generation per `media.md` §6's starter vocabulary (`thumbnail`/`medium`/`display` for images, `thumbnail`+`playable` for video — no resolution ladder, no adaptive bitrate, matching the explicit "no advanced video processing" exclusion); and the final `scanState`/`state` transition.

No queue technology beyond the existing `integration.outbox_events` mechanism is proposed (§1.2) — a dedicated job-processing library (e.g. BullMQ) is a **future** dependency question for whenever the worker itself is authorized, not decided here.

---

## 7. Attachment integration — how other modules safely reference media

The core requirement: **a user must not be able to attach another user's media by knowing its ID alone.**

For every attachment path — `Profile.avatarMediaId`, `Community.avatarMediaId`/`coverMediaId`, `PostMedia`, `MessageAttachment` — the *owning* module (Profiles, Communities, Content, Messaging), not Media, is responsible for the attach action, and must check, before writing the reference:

1. **The asset exists, is owned by the caller, and is `state=ready`.** A pending, rejected, or someone-else's asset is never attachable — this is a lookup the owning module makes (via an internal call into Media's service layer, not a second copy of Media's own logic — the same pattern `CommunityAccessService` already established as a cross-module dependency for Content).
2. **The asset's `purpose` matches the attachment target.** An asset reserved with `purpose=avatar` should not be attachable as a post image, and vice versa — enforced at attach time by the owning module checking `Asset.purpose`, not by Media guessing intent.
3. **The existing ownership/authorization rule for the target content still applies unchanged.** Setting a post's image still requires owning that post; setting a profile avatar still requires it being your own profile — Media adds an *additional* check (own the asset too), it does not replace the target's own check.

**Read-side (viewing attached media):** as established in §1.3, a viewer never calls `GET /media/{id}` to see an image inside a post/profile/message they're allowed to view. Instead, each owning module's own response (a future increment of `GET /posts/{id}`, `GET /profiles/{id}`, etc. — `media.md` §15 step 5, not built yet) embeds already-resolved signed variant URLs, computed *after* that module has already confirmed the viewer may see the parent content, using Media's service layer internally. This means:
- Block enforcement, community-membership checks, and profile-visibility rules are never duplicated in Media — they run once, in the module that already owns them (`media.md` §11's existing security section already states this; this section just explains the mechanism).
- Media's own read authorization (`GET /media/{id}`, owner-only) and the *attachment-context* read authorization (governed by the owning module) are two genuinely different things, deliberately, not an oversight.

---

## 8. Lifecycle

| State | Meaning | Client-triggered? | Server/worker-triggered? |
|---|---|---|---|
| `pending` | Reserved, not yet uploaded | Created by `POST /media/uploads` | — |
| `processing` | Upload complete, validation/variant generation in progress | Triggered by `POST .../complete` | Entered by the API on that call; left only by the worker |
| `ready` | At least one variant exists and passed validation/scan | — | Worker only |
| `rejected` | Failed validation/scan, or the upload expired/failed before completing | — | Worker (validation failure) or the future cleanup job (expired/failed upload, M-1) |
| `hidden` / `removed` | *(`moderationState`, not `state`)* — an already-`ready` asset actioned by Moderation | — | Moderation module (not built) |
| `deleted` | *(`deletedAt` set, not a `state` value — same two-track pattern as `ContentStatus`, `media.md` §3)* | `DELETE /media/{id}` | Also entered by the future orphan-cleanup job (48h grace period, `media.md` §8/§14) |
| *(upload) expired* | `Upload.status=expired` — reservation's `expiresAt` passed uncompleted | — | Future cleanup job only (M-1: **not yet enforced**, `media.md` §14) |

No state is ever set directly by a client request body — every transition above is either a side effect of a specific action (`complete`, `DELETE`) or worker/job-driven. This mirrors the same client-vs-server state-ownership split already established for `AssetState` in `media.md` §3.

---

## 9. Delete / retention

Restates the already-approved `media.md` §8 design at the API/job level — **no different retention period is introduced here.**

| | Behavior |
|---|---|
| **Delete request** | `DELETE /media/{assetId}` (§1.4): owner-only, soft delete, `404` on repeat, does not touch attachment rows |
| **Soft deletion** | `Asset.deletedAt` set; immediately excluded from every read path (§1.3) |
| **Object cleanup** | Future job calls `DeleteObject` for the asset's own key and every variant key, only after the retention window elapses and no attachment row still references it (the `RESTRICT` FK on `PostMedia.assetId`/`MessageAttachment.assetId` is what makes this ordering safe at the database level, `media.md` §8) |
| **Variant cleanup** | Cascade-deleted at the database level automatically when the `Asset` row is hard-purged (`media.md` §6) — no separate variant-cleanup logic needed |
| **Attachment cleanup** | Cascade-deleted at the database level when the *parent* post/message is deleted (`ON DELETE CASCADE` on `postId`/`messageId`); **not** automatically removed when only the *asset* is soft-deleted (§1.4) — that stays the owning module's own edit-flow responsibility |
| **Failed-upload cleanup** | Expired/failed `Upload` rows → `Asset.state` moves to `rejected` (§8) → same 7-day purge window as any other rejected asset (owner decision, 2026-09-22, `media.md` §14) |
| **Retention job boundary** | **Not implemented — tracked as M-1** (`media.md` §14): the 7-day and 48-hour parameters exist only as documentation and the indexes a future job would read (`(status, expiresAt)` on `Upload`, `(deletedAt)` on `Asset`). No scheduled job exists yet. This document does not change that status. |

---

## 10. Frontend handoff

No frontend code is written here — this is the contract the frontend team implements against.

1. **Upload initialization:** call `POST /media/uploads` with `kind`/`purpose`/`declaredMimeType`/`declaredByteSize`. Receive `{ assetId, uploadId, uploadUrl, uploadFields?, expiresAt }`.
2. **Signed-upload flow:** `PUT` (or POST with `uploadFields`, depending on the eventual presigning method) the file bytes directly to `uploadUrl` — never to the AfriLink API. This request goes straight to object storage.
3. **Completion flow:** on a successful upload, call `POST /media/uploads/{uploadId}/complete`. The asset is now `processing`.
4. **Loading/progress states:** upload progress comes from the direct-to-storage request itself (e.g. `XMLHttpRequest.upload.onprogress` or the platform's streaming-upload progress event) — the AfriLink API has no visibility into upload progress and exposes none. After `complete`, the frontend should show a "processing" state, not a progress bar (there's no progress signal for server-side processing at MVP).
5. **Retry behavior:** if the direct-to-storage upload fails before `expiresAt`, retry the same `uploadUrl` (idempotent at the storage layer for a plain PUT) — no need to re-initialize. If `uploadUrl` has expired, initialize a fresh reservation (§1.1's "not idempotent" note: this is expected and harmless).
6. **Failure behavior:** `GET /media/{assetId}` polling that returns `state=rejected` means the asset will never become ready — the frontend should let the user discard it and retry from initialization, not retry `complete`.
7. **Media status transitions:** poll `GET /media/{assetId}` after `complete` until `state` leaves `processing` (`ready` or `rejected`). No push/webhook notification exists for this at MVP (Notifications' own scope, `PRD` §20, doesn't name media-ready events) — polling is the only mechanism, matching how Notifications itself is REST-polled only for MVP (ADR-004 §7).
8. **Final media reference behavior:** once `ready`, the `assetId` is what gets passed to whichever owning module's endpoint performs the attach (e.g. a future `avatarMediaId` field on `PATCH /me/profile`, `media.md` §15 step 5) — the frontend never constructs or stores a storage URL itself; every URL it ever displays comes from an API response (`variants[].url` on `GET /media/{id}`, or an owning module's future embedded-media field), generated fresh, per request.

---

## 11. Local development & test strategy

**Not adopted yet — evaluated only, per the explicit instruction not to add this without separate approval.**

A self-hosted, S3-API-compatible server (the MinIO project's own server binary, distinct from the `minio` *client* npm package evaluated in §3) run via Docker Compose — alongside the existing `afrilink_postgres_dev` container — is the standard way to develop and test against an S3-compatible target without any real vendor account, credentials, or network dependency. `@aws-sdk/client-s3` (§3/§4) would point at it by overriding `endpoint`/`forcePathStyle`/local credentials, with zero code difference from pointing at a real provider later — this is the entire point of choosing a protocol-neutral client.

**Test strategy implications (design-level, not implemented):**
- E2E tests would need either a running local S3-compatible server (mirroring how `test/*.e2e-spec.ts` already require a running local Postgres) or a mocked/stubbed S3 client for the parts of the flow that don't need real bytes (e.g. asserting a presigned-URL response shape without actually uploading).
- Constraint/lifecycle tests (state transitions, ownership, retention-eligibility) do not need real storage at all — they test Postgres state directly, the same mutation-tested, `EXPLAIN`-verified rigor already applied to every other module this project.
- Nothing about this local-dev strategy is installed or configured by this document.

---

## 12. Open decisions

1. **Exact MIME allowlist per `(kind, purpose)`.** Not specified anywhere approved (PRD §31: "exact file limits... deferred alongside vendor selection").
2. **Exact maximum declared/verified byte size.** Same deferral.
3. **Exact upload-URL/reservation expiry duration** (minutes). Distinct from the already-approved 7-day/48-hour *downstream* cleanup windows.
4. **Exact signed-GET URL TTL** for `variants[].url` in `GET /media/{id}` responses.
5. **CJS/ESM compatibility of the `minio` npm client** — not verified this session (moot unless `@aws-sdk/client-s3` is rejected in favor of it).
6. **Whether a declared-checksum mismatch at completion should reject immediately** (API-level, before the worker even runs) or always defer to the worker's own authoritative check. Leaning toward "always defer to the worker" (never trust client-declared facts) but not conclusively resolved by any approved document.

None of these block this document's own scope (API/storage architecture, dependency gate) — they block the *next* phase (actual implementation), and are the concrete parameters that phase's proposal would need to either resolve or explicitly inherit as still-open.

## 13. Recommended implementation sequence

1. Owner resolves (or explicitly defers) the open decisions in §12.
2. Separate, explicit dependency-install authorization for `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner` (§4) — no earlier step in this document installs anything.
3. Controllers/services/DTOs for the four routes in §1, tests-first, same rigor as every prior module (mutation checks, `EXPLAIN` where relevant, completeness-guard registration for the two UUID path parameters).
4. Local S3-compatible dev target (§11), only once explicitly approved as its own step.
5. Processing worker (§6) as its own later, separately authorized phase — not bundled into step 3.
6. Only after the Media API and worker exist: the attachment increments named in `media.md` §15 step 5 (`avatarMediaId` on `PATCH /me/profile`, post/message media fields) — each its own reviewed increment in the owning module, not Media's own scope.

# VK materials and manual inbox: API research and gap audit

This document supports FR-001 through FR-008 in [spec.md](spec.md). It records public API evidence and the chosen increment, not live VK acceptance. The development boundary remains draft PR only: no credentials, OAuth issuance, permission changes, live uploads/messages, deployment, merge or timer changes.

Repository process and constitution version 1.0.0 were read with AGENTS.md, the feature specification and plan. The starting checkout is branch `088-vk-materials-inbox` at PR449 merge `93e6e70fc8a907c3ceac3e87352afc578362c48b`. This research task owns this file only; the coordinator owns integration and validation evidence.

## Source confidence

GitHub's read-only comparison of VKCOM/vk-api-schema commit `333481bd082ad747d4873ef4a77f9247097eeef0` with `master` returned `identical`, zero commits ahead or behind. The schema declares API version `5.199`; the commit is from April 2025. Thus this is the current public repository schema observed during research, not proof that every method is usable with a particular live account, application or token. The comparison is reproducible through the [official repository comparison](https://github.com/VKCOM/vk-api-schema/compare/333481bd082ad747d4873ef4a77f9247097eeef0...master).

The `dev.vk.com` method/upload pages could not be fetched in this environment. Method contracts below use the pinned official schema, with multipart field names corroborated by the official SDK. No third-party tutorial, guessed permission mask or live VK call is treated as evidence.

<a id="API_SCOPE"></a>

## API_SCOPE

`groupId` below means the positive community ID from the current company's checked server-side binding. Negative `owner_id` addresses that community. `peerId` comes from a previously loaded, eligible one-to-one conversation in the same binding. Token labels are the schema's exact `access_token_type` values; they do not establish minimum OAuth permissions.

| Purpose | Exact method contract used or evaluated | Supported token types | Increment decision |
| --- | --- | --- | --- |
| List existing albums | `photos.getAlbums({owner_id:-groupId, need_system:0, need_covers:1, offset, count})` | `user`, `service` | Use the checked user-type design binding; service-token support in VK is not a new Synapse connection path. |
| Request album upload | `photos.getUploadServer({group_id:groupId, album_id})` | `user` | Existing selected album only. Community-type design binding fails closed. |
| Save album photo | `photos.save({group_id:groupId, album_id, server, photos_list, hash, caption})` | `user` | Explicit confirmed apply only. Response is an array of photo objects. |
| Read album/photo back | `photos.get({owner_id:-groupId, album_id, photo_ids, count})` or `photos.getById({photos})` | `user`, `service` | Compare saved IDs, owner and album before calling a result verified. Provider acceptance alone is not verification. |
| Read incoming attachments | `messages.getHistory({group_id:groupId, peer_id:peerId, offset, count})` | `user`, `group` | Extend existing manual history sanitization to photo/document metadata. Existing inbox continues to use its community token. |
| Optional dedicated attachment history | `messages.getHistoryAttachments({group_id:groupId, peer_id:peerId, media_type:"photo"/"doc", count, start_from})` | `user`, `group` | API evidence only; no separate media-browser feature required for this increment. |
| Request message-photo upload | `photos.getMessagesUploadServer({peer_id:peerId})` | `user`, `group` | Same checked community token as inbox; upload only after confirmation. This method has no `group_id` parameter in the schema. |
| Save message photo | `photos.saveMessagesPhoto({server, photo, hash})` | `user`, `group` | Returns an array of photo objects; retain a scoped local reference to the saved object. |
| Request message-document upload | `docs.getMessagesUploadServer({peer_id:peerId, type:"doc"})` | `user`, `group` | PDF is the chosen Synapse outgoing document subset. This method has no `group_id` parameter in the schema. |
| Save message document | `docs.save({file, title})` | `user`, `group` | Returns an object containing `type` and `doc`, not an array. Accept the expected document shape only. |
| Manual reply | `messages.send({group_id:groupId, peer_id:peerId, random_id, message, attachment})` | `user`, `group` | Existing one-to-one eligibility checks remain. `attachment` is singular and contains `photo<owner_id>_<id>` or `doc<owner_id>_<id>` derived server-side from this confirmed operation. |
| Create album | `photos.createAlbum({group_id:groupId, title, description, upload_by_admins_only, comments_disabled})` | `user` | Deferred; no implicit album creation during photo upload. |
| Community document library | `docs.getUploadServer({group_id:groupId})` then `docs.save({file,title})`; listing uses `docs.get({owner_id:-groupId})` | `getUploadServer`/`get`: `user`; `save`: `user`, `group` | Deferred. This differs from documents attached to a private client reply. |
| Community avatar | `photos.getOwnerPhotoUploadServer({owner_id:-groupId})` then `photos.saveOwnerPhoto({server,hash,photo})` | `user` for both | Deferred because saving may create a wall post; see below. |

Method and token-type evidence: [photos methods][photos-methods], [docs methods][docs-methods], [messages methods][messages-methods]. Response evidence: [photos responses][photos-responses], [docs responses][docs-responses]. Incoming typed attachment objects and optional media access keys are described in [messages objects][messages-objects], [photos objects][photos-objects] and [docs objects][docs-objects].

The schema describes `message` as optional when an attachment is provided, and `attachment` as optional when text is provided. The existing text-only reply path therefore remains compatible. The provider can still deny a confirmed send after a successful conversation/read check; neither reading public community data nor `can_write.allowed` guarantees the eventual write succeeds.

## Upload protocol and side effects

The official Java SDK's pinned [Upload action][java-upload] uses multipart field `photo` for a single album photo, private-message photo and owner photo; `file` for a document. The [official PHP SDK photo-message example][php-readme] independently shows multipart `photo`, then saving `server`, `photo` and `hash`. Album upload instead saves the returned `photos_list` with `server` and `hash`. Opaque upload fields are passed only between the server and VK, never accepted from a public client as authority to send an attachment.

`photos.saveOwnerPhoto` supports a community owner but its response can contain `post_id`, documented as a created post ID. Its request has no documented suppression flag. Avatar editing must not be advertised as a silent image-only change. It is deferred pending a separate product decision about that side effect alongside the preserved Onlypult publication path. The absence of avatar in this increment is not an assertion that VK lacks an avatar API. [Response evidence][photos-responses].

The application makes no wall publication calls for album materials or client replies. This does not establish that VK never displays provider-generated album activity. The existing Onlypult publication integration is not changed.

## Permissions and token issuance remain unresolved

The official method schema establishes token types but contains no per-method minimum scope contract. The official PHP SDK enumerates community scopes including `photos`, `messages`, `docs` and `manage`, and user scopes including `photos`, `docs`, `groups` and `stats`. Enumeration alone does not prove which combination each method requires. No numeric mask, blanket grant or instruction to enable all scopes is approved by this research. [Community scopes][group-scopes], [user scopes][user-scopes].

Successful design identity/public-community reads prove identity/read access only. They must not become a claim that album editing is authorized. Existing statistics checks read actual statistics; inbox checks read conversations without sending. Permission denial during a confirmed upload/save is a separate result and must remain visible.

A user-type design binding requires a legitimately issued token for an appropriate application and account. Current official SDK authorization parameters include `client_id`, `redirect_uri`, state and PKCE; this does not establish that the user's existing application has the necessary API permissions or eligibility. The private token-entry UI is not an OAuth issuance flow. Choosing/registering an application, configuring redirect, acquiring tokens and changing grants remain unresolved owner-controlled setup outside this development task. No credentials or OAuth configuration are created or read here. [Official authorization parameters][user-oauth].

## Application safety decisions

These are Synapse constraints, not claimed VK provider limits:

- Allow outgoing JPEG/PNG and PDF only, with bounded bytes, dimensions and decoded response size; validate signatures and declared types. Exact provider file/dimension limits were not confirmed from accessible primary documentation.
- Preparation stores a private local preview; it performs no VK upload, save or send. Confirmation freezes content hash, caption/text, destination, company and binding revision.
- Upload destinations come only from the VK API response and must pass HTTPS/host validation. Reject URL credentials, unapproved ports, arbitrary URL ingestion and redirects. Apply timeouts and bounded request/response bodies. Do not log upload URLs, hashes, tokens, access keys or raw provider error bodies.
- Incoming attachment URLs/text are untrusted. Sanitize metadata and allowed media links, escape labels and never render document bytes as executable page content. Unsupported types remain visible as unavailable. An incoming or client-supplied attachment ID does not authorize outgoing reuse.
- Bind preview and operation records to company, binding revision, community and peer/album. The server chooses those values from validated state. Reject stale bindings and foreign previews, and preserve the owner/CSRF proxy boundary.
- `messages.send.random_id` is documented as duplicate-send protection, but the schema promises no deduplication lifetime. `photos.save`, `docs.save`, `photos.createAlbum` and `photos.saveOwnerPhoto` expose no idempotency key. Persist a unique operation claim before the first mutation; concurrent or repeated requests return the existing state. Unknown upload/save/send results never trigger a blind automatic retry.
- A saved message attachment may belong to the uploading token's owner rather than a negative community owner. Do not substitute a guessed owner ID; validate the response and preserve isolation through the scoped operation, token binding and peer. Verify the community owner/album for public album saves.

## Baseline gap audit and coverage boundary

This table distinguishes the inherited PR449 baseline from the scoped plan. It is not a claim that the new code is implemented, tested, deployed or accepted. Actual checks belong in [evidence.md](evidence.md).

| Requested area | PR449 baseline | Feature 088 scope | Remaining gap |
| --- | --- | --- | --- |
| Community description and static cover | Separate design binding, preview, explicit apply, readback, audit and duplicate protection. | Preserve existing behavior. | Avatar deferred; menu, market and other design surfaces not included. |
| Statistics | Separate analytics binding and direct read checks. | Preserve existing behavior. | No new analytics/background collection in this increment. |
| Community photo/material upload | No album-photo workflow. | List existing albums; preview and confirm one JPEG/PNG with caption; distinguish accepted from verified. | Album creation/deletion, bulk uploads, community document library, videos and arbitrary material formats remain absent. |
| Client correspondence | Manual text-only one-to-one inbox. | Display sanitized incoming photos/documents; local preview and explicit confirmation of text and at most one JPEG/PNG or PDF. | Other outgoing formats, group conversations, forwarded-message resend, editing/deletion and a dedicated media archive remain absent. |
| Publishing | Existing Onlypult integration. | Preserve that path unchanged. | No replacement publisher or automatic send is introduced. |
| Refresh and automation | Manual refresh; no callback/Long Poll/auto-reply. | Preserve manual-only operation. | Background refresh, callback/Long Poll and automatic replies remain outside scope. |
| Setup and live readiness | Separate bindings and private token-entry UI. | Explain capability-specific token types and honest failure states. | Exact minimum scopes, appropriate OAuth/application configuration and real-account verification remain unresolved. |

Mock validation must cover zero external writes during preview, one confirmed mutation chain, duplicate/concurrent requests, ambiguous outcomes, company/revision/peer/album isolation, hostile file/URL/provider-response handling and preview invalidation in the UI. Existing text-only inbox, cover/description, proxy protections and Onlypult regressions must remain green. Passing mocks proves the implemented contract under those fixtures; it does not prove live token eligibility or deployment.

[photos-methods]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/methods.json
[photos-responses]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/responses.json
[photos-objects]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/photos/objects.json
[docs-methods]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/docs/methods.json
[docs-responses]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/docs/responses.json
[docs-objects]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/docs/objects.json
[messages-methods]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/messages/methods.json
[messages-objects]: https://github.com/VKCOM/vk-api-schema/blob/333481bd082ad747d4873ef4a77f9247097eeef0/messages/objects.json
[java-upload]: https://github.com/VKCOM/vk-java-sdk/blob/3be91e5f2ab52133897e67f4b53379ee180d865a/sdk/src/main/java/com/vk/api/sdk/actions/Upload.java
[php-readme]: https://github.com/VKCOM/vk-php-sdk/blob/cf5b8d84440256e1595d067ef255cbc8e372eb0d/README.md
[group-scopes]: https://github.com/VKCOM/vk-php-sdk/blob/cf5b8d84440256e1595d067ef255cbc8e372eb0d/src/VK/OAuth/Group/Scopes.php
[user-scopes]: https://github.com/VKCOM/vk-php-sdk/blob/cf5b8d84440256e1595d067ef255cbc8e372eb0d/src/VK/OAuth/User/DTO/Scopes.php
[user-oauth]: https://github.com/VKCOM/vk-php-sdk/blob/cf5b8d84440256e1595d067ef255cbc8e372eb0d/src/VK/OAuth/User/DTO/AuthorizeUrlParams.php

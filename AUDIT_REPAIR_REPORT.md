# SAVAGE MD V3.3.3 — Deep Audit, Targeted Repair & Regression Protection

**Repository:** `Anonymous20666/Savage-test` · **Branch:** `arena/fff9d7ec-savage-test`
**Project:** `SAVAGE MD V3.3.3/` (Telegram control panel for a WhatsApp Multi-Device group-management bot: telegraf + express + SQLite (`node:sqlite`) + Baileys fork `@whiskeysockets/baileys` → `@itsliaaa/baileys@0.3.18-final`)
**Date:** 2026-10-20
**Scope:** repair of an existing system — no redesign, no command removed/renamed/changed, smallest compatible fixes only.

---

## 1. Executive summary

All three owner-identified problem areas were investigated to root cause with reproduced evidence before any edit. Five concrete defects were found and repaired, each with regression tests. The command surface is **byte-identical** before vs after (47 Telegram commands + 3 aliases, 686 WhatsApp commands across 474 plugins). Real end-to-end tests against live authorized WhatsApp/Telegram accounts could **not** be executed in this environment (no WhatsApp/Telegram network access and no paired accounts here) — those items are marked **NOT VERIFIED** below, per the agreed standard.

| Problem area | Root cause(s) found | Status |
|---|---|---|
| 1. Preview failing | Preview cards attached raw CDN image bytes (often large PNG) into `jpegThumbnail` — WhatsApp drops such images (the exact "title/description but no image" symptom `.debuglink` was written to diagnose); no `highQualityThumbnail` for Status-size rendering | Repaired + tested; live-WA rendering NOT VERIFIED |
| 2. Group Status broken | `serialize.unwrapMessage` did not unwrap `groupStatusMessage`/`groupStatusMessageV2` envelopes, so incoming Group Status posts and replies quoting one had empty bodies and wrong types — commands, quoted-content flows and anti-* scans silently skipped them | Repaired + tested; live posting NOT VERIFIED |
| 3. Pairing/session unreliable | Pairing-code retry leaked a second live socket (two `creds.update` writers on one auth dir) per retry; same-session build races; stale-socket listeners; DB upsert could orphan a paired session (owner/phone lost); WA-side `.pair` leaked clone-instance sessions into the master namespace | Repaired + tested; live multi-user pairing NOT VERIFIED |

---

## 2. Project understanding

- **Architecture.** Single bundled `bot.js` (27,964 lines, esbuild-style `__commonJS` modules with original file paths in comments) + SAVAGE PLUS plugin layer inlined at lines 6–2575. `index.js` bootstraps: DB migrations → plugin loader (474 WA plugins / 686 commands) → Express `/api` panel → Telegram bot (`buildBot` middleware chain) → `waManager.restoreSessionsOnBoot()` → watchdogs/schedulers (GG Status, GG interval, autojoin, link rotation/vault, DB maintenance, group-mute, clone restore).
- **WhatsApp layer.** `waManager` keeps one Baileys socket per session (`sessions/{sessionId}` auth dirs), handles pairing-code flows, reconnection with backoff, health watchdog, and inbound dispatch through `perf.acquireInbound` → `waCommandHandler` (serialize → group guard → plugin dispatch).
- **Multi-tenancy.** "Clones" = independently branded Telegram bot instances, each with `clone_xxxxxxxx__`-prefixed session IDs (`cloneRuntime`), plus per-owner session scoping (`sessionAccess`, `sectionManager`).
- **Key features in scope.** Preview = rich link previews on outbound WA text (`linkPreview.js` + `channelPreview.js` + `pfpCache.js` + sendMessage guard). Group Status = posting `groupStatusMessageV2` messages to groups (`.ggstatus`, `.gstatus`, `.togstatus`, Telegram `/ggstatus`, `/auto ggstatus`, two schedulers). Pairing = Telegram `/pair` / WA `.pair` → `whatsapp.pair` → `waManager.createSession` with per-session auth.

## 3. Methodology

Audit-first: module map extraction → full read of every file in the three feature areas → evidence-based bug candidates → **reproduction tests that failed on the pristine code** → minimal fixes → full regression re-run. No root cause was assumed in advance (including "Baileys is guilty"). The bundled test harness (`tests/harness.js`) loads the bundle's internals without booting the app; a mock Baileys layer exercises pairing/socket lifecycle deterministically.

## 4. Finding & repairing the Preview problem

**Investigated.** All preview surfaces: `lib/whatsapp/linkPreview.js` (group/channel/generic builders), `channelPreview.js` + `waChannelCache.js`, `pfpCache.js`, the per-socket `sendMessage` preview guard (`finishSocketSetup`), outbound call sites (`buildOutboundContent`, `buildGroupStatusContent`, `groups.js` gcast, DM auto-preview in `waCommandHandler`, `.debuglink`, `.linkpreview`), Telegram-side `/link` cards, and the fork's own `getUrlInfo`/`generateWAMessageContent` interop. Payload interop with the fork was tested directly (title/description/matchedText/jpegThumbnail/contextInfo all copy correctly).

**SaaS preview implementation (Phase 3 result).** An exhaustive search of this machine (filesystem sweeps of `/`, `/home`, `/opt`, `/srv`, `/var/www`, `/maxdepth`-5 finds for `preview*`/`saas*` apps and stray sources; process list; listening ports; systemd units; pm2/docker absent) found **no separate SaaS preview application — none exists in this environment**. Per instructions, that is stated honestly rather than pretended. As the reference implementation I used the **working preview code already inside the project's own dependency**: the Baileys fork's `getUrlInfo()` thumbnail pipeline (`extractImageThumb` compression + `prepareWAMessageMedia` thumbnail-link upload), which produces previews WhatsApp actually renders. The repair reuses exactly that code — no new dependencies, no new preview architecture.

**Root cause.** `fetchThumbnailBuffer` fed **raw CDN bytes** into `jpegThumbnail`. WhatsApp profile pictures can be large PNG/JPEG files; `jpegThumbnail` must be a small JPEG. WhatsApp drops invalid/oversized thumbnails → card renders title/description only. The bot also never built `highQualityThumbnail` (the large image used for Status-size rendering — documented in `.debuglink`'s own output), while the fork's reference path builds both.

**Repair (bot.js → lib/whatsapp/linkPreview.js).**
- `toJpegThumbnail()`: compress fetched images via the fork's `extractImageThumb(…, 192)` (same reference the fork uses), falling back to the raw buffer only if no image library exists (preserves old behavior as last resort).
- `uploadHighQualityThumbnail()`: best-effort `prepareWAMessageMedia({image:{url}}, {upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link'})` — identical flow to the fork's `getUrlInfo()` — attached as `highQualityThumbnail` on group/channel previews. Failure degrades gracefully (small JPEG still attached).
- Generic-URL previews (fork `getUrlInfo`) and all commands/entry points unchanged.

**Verified limits.** Unit/E2E: JPEG magic bytes, size bound, HQ thumbnail attachment, sendMessage-guard injection, caching, passthrough — all pass. **NOT VERIFIED:** rendering of the preview card on a real WhatsApp client.

## 5. Investigating and repairing Group Status

**Investigated.** Full chain: `.ggstatus`/`.gstatus`/`.togstatus` plugins → `integrations/whatsapp/commands.js` (`buildGroupStatusContent`, `postGroupStatus`) → `perf.runBroadcast` → fork `generateWAMessageContent` (`groupStatus: true` → wraps `groupStatusMessageV2`, sets `contextInfo.isGroupStatus`, adds `<meta is_group_status='true'/>`) → receive side (`serialize`, `waCommandHandler`, `waGroupEvents`) → Telegram `/ggstatus`, `/auto ggstatus`, interval scheduler + both schedulers' claim/release locking. The **send path was proven healthy** (reproduction tests pass on pristine code: payload wraps correctly, previews survive the wrapper, PPGC reporting correct).

**Root cause (reproduced on pristine code).** The receive/parse path: `serialize.unwrapMessage` handled only `viewOnce*`/`ephemeralMessage`/`documentWithCaptionMessage` wrappers. Group-Status envelopes therefore serialized as `type: "groupStatusMessageV2", body: ""` — including **replies quoting a Group Status**. Consequences: commands in status replies never dispatched; `.ggstatus`/`.gcast` reply-content resolution saw empty text; anti-* body scans (badword/foreign/link) skipped status content; anti-delete reposts showed empty bodies. (The fork's own `extractMessageContent` unwraps these wrappers — the bot's mirror list was simply missing them.)

**Repair (bot.js → lib/whatsapp/serialize.js).** `STATUS_WRAPPER_KEYS = ["groupStatusMessage", "groupStatusMessageV2", "spoilerMessage"]` added to `WRAPPER_KEYS`. Status **mention** wrappers (`statusMentionMessage`/`groupStatusMentionMessage`) deliberately remain raw: they carry only a protocolMessage stub and `antigroupstatus.js` detects them from raw envelope keys (its behavior is unchanged).

**Verified limits.** Payload build/send (mocked socket) PASS; receive-side unwrap of own sent `groupStatusMessageV2` (body, type, quoted) PASS; GG-Status schedulers' locking reviewed intact. **NOT VERIFIED:** a live status actually appearing in WhatsApp (needs authorized accounts).

## 6. Pairing and session isolation deep audit (A–H)

| Lifecycle area | Audit result | Action |
|---|---|---|
| A. Ownership model | WA side: `isSessionOwner` = self-JID ✓; Telegram side: `sessionAccess.authorizeSession` + clone scoping ✓. **Defect:** `whatsapp_sessions` upsert on conflict wrote `phone_number = excluded.phone_number` and never `owner_telegram_id` — status-only updates with NULL fields could blank the phone or leave a NULL/stale owner, making a paired session invisible to its own owner (`/mysession`, `getSessionScope`, broadcasts all miss it) | upsert now `COALESCE`s owner and phone (new value wins when supplied) |
| B. Auth isolation | Auth dirs already per-session ✓. **Defect:** stale sockets kept live `creds.update`→`saveCreds` writers (pairing retry + `createSession` replace path), two writers racing one `creds.json` | `creds.update` handler now ignores sockets that no longer own the session; replaced sockets are disposed (listeners stripped) before `end()` |
| C. Concurrent pairing | Different users: genuinely concurrent (per-session dirs, socket-init slot queue) ✓ reproduced. **Defect:** same-session races (double `/pair`, pair vs reconnect, supervisor vs pair) could interleave `buildSocket`s → duplicate live sockets (→ WhatsApp duplicate-connection conflicts) | new **per-session** lock (`withSessionLock`) around create/retry/rebuild paths — scoped to one sessionId only; other users unaffected |
| D. Event routing | Inbound dispatch already guarded per current socket ✓. **Defect:** `waGroupEvents` handlers (welcome/goodbye, anti-demote/promote, anti-delete cache) processed events from superseded sockets → duplicate messages | all three handlers now require `isCurrentSock()` |
| E. DB persistence | Schema fine; **defect** as in A | fixed |
| F. Cleanup/reconnection | `disposeSocket`/backoff/watchdog/restore sound ✓; pairing-code retry however rebuilt without disposing the old socket — **reproduced: 2 live sockets after 1 retry** | retry now disposes the failing socket first and re-resolves the live socket after its delay |
| G. Authorization/secrets | Telegram `session_*` callbacks owner-gated ✓; section selection scoped to owner's sessions ✓; foreign-number pairing guarded (Telegram + WA) ✓. **Defect:** WA-side `.pair` created clone-instance sessions in the master namespace (no `clone_` prefix) and could hijack another instance's session for the same number | WA `.pair` now derives the instance from the issuing session, prefixes new session IDs accordingly, and rejects numbers linked to a different instance (same rule as `resolvePairingSession`) |
| H. Multi-instance | Clone restore/start/stop serialised via `withLock` ✓; per-instance Telegram tokens encrypted (AES-GCM), tokens scrubbed from logs ✓ | unchanged |

**Verified limits.** Mock-Baileys suite reproduces the pre-fix duplicate-socket leak and proves post-fix: one live socket per session after retries/reconnects, correct DB ownership, stale-event immunity, logout of one session never touches another, auth-dir removal scoped. **NOT VERIFIED:** live Telegram+WhatsApp pairing with real accounts.

## 7. Backup and change control

- Original archive kept untouched: `SAVAGE_MD_V3_3_3.zip` (pristine reference).
- Git baseline commit **`5aa732f`** ("baseline: extract SAVAGE MD V3.3.3 …") captures the extracted project **before** any repair. Repairs are one reviewable commit **`16893da`**.
- Runtime state (DB, logs, `sessions/` auth) excluded from Git (`.gitignore`) and untouched. No existing auth/session state was wiped for testing (mock-based tests use throwaway in-memory state).
- No secrets in logs/reports/test output; `.env` values never printed.

## 8. Files changed and exact intent

| File | Change | Intent |
|---|---|---|
| `SAVAGE MD V3.3.3/bot.js` → `lib/whatsapp/serialize.js` | +`STATUS_WRAPPER_KEYS` in `WRAPPER_KEYS` | unwrap Group Status / spoiler envelopes for body/type/quoted extraction |
| `SAVAGE MD V3.3.3/bot.js` → `lib/whatsapp/linkPreview.js` | `toJpegThumbnail()` via fork `extractImageThumb`; `uploadHighQualityThumbnail()` via fork `prepareWAMessageMedia`; wired into `buildGroupLinkPreview`/`buildChannelLinkPreview` | real JPEG `jpegThumbnail` + best-effort `highQualityThumbnail` (preview image renders; status-size cards work) |
| `SAVAGE MD V3.3.3/bot.js` → `database/models/sessions.js` | upsert `COALESCE` for `owner_telegram_id`, `phone_number` | paired sessions can't be orphaned/blanked by status-only updates |
| `SAVAGE MD V3.3.3/bot.js` → `plugins/owner/pair.js` | instance-scoped session ID + cross-instance guard | WA `.pair` stays inside its bot instance's namespace |
| `SAVAGE MD V3.3.3/bot.js` → `events/waGroupEvents.js` | `isCurrentSock()` guards | no duplicate processing from superseded sockets |
| `SAVAGE MD V3.3.3/bot.js` → `integrations/whatsapp/bot.js` (waManager) | `withSessionLock` (per session); pairing-retry dispose+re-resolve; `scheduleReconnect` rebuild under lock; `creds.update` staleness guard; `createSession` dispose-before-end + locked | one live socket & one creds writer per session; same-session ops serialised; cross-user concurrency preserved |
| `SAVAGE MD V3.3.3/tests/*` (new) | harness, 6 suites, runner, inventory baseline/post-repair JSON | regression protection (83 assertions) + command-inventory proof |

**Rollback.** `git checkout 5aa732f -- "SAVAGE MD V3.3.3"` restores the pristine project (or extract `SAVAGE_MD_V3_3_3.zip` over it). No DB migration needs undoing (the only SQL change is an upsert statement, compatible with existing rows).

## 9. Test results (real runs; unverifiable items marked NOT VERIFIED)

| # | Test | Method | Result |
|---|---|---|---|
| 1 | Preview payload ↔ Baileys fork interop (title/desc/thumbnail/brand) | `tests/test-preview-gstatus.js` | **PASS** |
| 2 | Group Status payload wrap (`groupStatusMessageV2`, media+text, brand) | `tests/test-preview-gstatus.js` | **PASS** |
| 3 | Group Status receive unwrap (body/type, incl. quoted) | `tests/test-preview-gstatus.js` | **PASS** (failed pre-repair — reproduced) |
| 4 | Group/channel link preview build (fake socket) | `tests/test-linkpreview.js` | **PASS** |
| 5 | Preview thumbnail is compressed JPEG + HQ thumbnail attached | `tests/test-linkpreview.js` | **PASS** (failed pre-repair — reproduced) |
| 6 | `.ggstatus` broadcast + `.togstatus` single send (mocked socket) | `tests/test-gstatus-send.js` | **PASS** |
| 7 | `.gcast` never sends group-status wrapper | `tests/test-gstatus-send.js` | **PASS** |
| 8 | sendMessage guard: preview injection, groupStatus passthrough, cache | `tests/test-send-guard.js` | **PASS** |
| 9 | Concurrent pairings by two users: distinct auth dirs, correct DB owners | `tests/test-pairing.js` T1 | **PASS** |
| 10 | Pairing-code retry leaves exactly one live socket / one creds writer | `tests/test-pairing.js` T2 | **PASS** (reproduced leak pre-repair) |
| 11 | Reconnect disposes old socket; no listener multiplication | `tests/test-pairing.js` T3 | **PASS** |
| 12 | Logout of one session never touches another session's socket/auth | `tests/test-pairing.js` T4 | **PASS** |
| 13 | Stale-socket events ignored | `tests/test-pairing.js` T5 | **PASS** |
| 14 | Session upsert keeps/repairs owner & phone | `tests/test-session-ownership.js` | **PASS** (failed pre-repair) |
| 15 | Instance scoping rule (master vs clone namespace) | `tests/test-session-ownership.js` | **PASS** |
| 16 | Command inventory baseline vs post-repair | `tests/inventory-*.json` diff | **PASS — identical**: 47 TG commands + 3 aliases (50 registrations), 686 WA commands, 474 plugins, SAVAGE PLUS alias map identical, callback surface identical |
| 17 | Startup/deploy smoke (`node index.js`) | live run | **PASS** through DB, plugin load (686/474), 50 Telegram command registrations, all workers/schedulers, Express :3000; process then stops at Telegram `getMe` because **api.telegram.org is unreachable from this sandbox** (environmental) |
| 18 | Live Telegram command invocation (e.g. `/commands`, `/pair`) | real bot token | **NOT VERIFIED** (Telegram API unreachable here) |
| 19 | Live WhatsApp pairing with authorized accounts (multi-user) | real devices | **NOT VERIFIED** (no authorized WhatsApp accounts / WA network in this environment) |
| 20 | Live Group Status post visible in WhatsApp | real account | **NOT VERIFIED** |
| 21 | Live preview card image rendering on WhatsApp clients | real account | **NOT VERIFIED** |
| 22 | Reuse of "SaaS preview implementation on this VPS" | filesystem/process/service search | **NOT FOUND** — no such application exists in this environment (documented, not faked) |

Automated suite: `node tests/run-all.js` → **6/6 suites, 83/83 assertions PASS**.

## 10. Definition of done

| Criterion | Status |
|---|---|
| Preview repaired to verified limits (unit/E2E; reference implementation reused) | **Done** (live render NOT VERIFIED) |
| Group Status repaired to verified limits (receive path fixed; send path proven) | **Done** (live post NOT VERIFIED) |
| Pairing & session management reliable and isolated (reproduced defects fixed; per-session scoping; concurrency preserved across users) | **Done** (live multi-user pairing NOT VERIFIED) |
| Every existing command intact: names, aliases, permissions, triggers, responses | **Done — inventory identical (16)** |
| Audit before edit; root causes evidenced by reproduction | **Done** |
| Smallest compatible repair; no rewrites, no new registry/architecture/deps | **Done** |
| Existing sessions/auth preserved; no wipes/reset for testing | **Done** (7) |
| No secrets in logs/reports/backups | **Done** (7) |
| Honest reporting of unverifiable items & missing SaaS preview | **Done** (9) |

## 11. Rollback & operational notes

- **Rollback:** `git checkout 5aa732f -- "SAVAGE MD V3.3.3"` (pristine extract) or restore from `SAVAGE_MD_V3_3_3.zip`. Repair commit `16893da` can be reverted wholesale (`git revert 16893da`).
- **Deploy:** restart via the established process (`npm start` / the service manager used on the VPS). No config change, no dependency change, no DB migration beyond the corrected upsert statement (backwards compatible).
- **Install note:** in restricted networks `npm install --omit=dev --legacy-peer-deps` may fail at `ffmpeg-static`'s download; `--ignore-scripts` installs the tree without it (ffmpeg only needed for media conversion features).
- **Watch after deploy:** `.debuglink` now reports both `jpegThumbnail` and `highQualityThumbnail`; pairing logs should show at most one live socket per session (no repeated "pairing code request failed" followed by silent reconnect storms).

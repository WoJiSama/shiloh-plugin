# Message Pipeline Architecture

## Purpose

This pipeline owns message capture, recent context, NDJSON archives, media relay jobs, and OneBot delivery. It exists outside the Yunzai app dispatcher because the dispatcher can reject duplicate-looking messages before any app plugin runs. In particular, its duplicate key does not contain `group_id`, so the same user forwarding the same card to two groups can otherwise lose one event.

## User Invariants

1. The same Bilibili or Douyin share sent to two groups creates two independent delivery jobs.
2. A slow download in one group does not block capture or delivery in another group.
3. A retry does not duplicate recent-context rows or NDJSON records.
4. A media resource failure still produces a merged-forward information node when stable card data exists.
5. A OneBot response is never marked `sent` without a valid `retcode=0` receipt.
6. A transport exception with an unknown delivery outcome is not retried automatically, because doing so can duplicate a visible group message.
7. AI chat, dice, moderation, Excel, image jobs, and command routing remain in the app dispatcher and do not own archive or media delivery side effects.

## Ownership

```text
Bot EventEmitter
  -> EventEnvelope capture
  -> Redis event job
      -> recent-context upsert
      -> NDJSON append-once
      -> optional emoji auto-collection dispatch
      -> media delivery enqueue
          -> metadata refresh
          -> lowest-resolution media assembly
          -> per-group serial delivery
          -> DeliveryGateway / OneBot receipt
```

- `index.js` installs the only raw `message` and `notice` listeners.
- `MessagePipeline` owns event jobs and consumer progress.
- `MessageManager` owns recent Redis context only.
- `MessageArchiveManager` owns NDJSON files only.
- `MediaOutbox` owns media refresh, resource assembly, retry state, and per-group ordering.
- `DeliveryGateway` is the only automatic media path that calls `send_group_forward_msg`.
- `apps/MessageManager.js` keeps query and administration commands; it is not a catch-all recorder.

No durable job contains the original Yunzai event object, bound methods, `e.reply`, `e.group`, or `e.friend`. The gateway resolves the live bot from `Bot.bots[botId]` when delivery runs.

## Identities

Event identity:

```text
v1:botId:postType:conversationType:conversationId:messageId
```

When OneBot does not provide a message ID, the last component is a bounded hash that includes the conversation, sender, timestamp, and raw message.

Media delivery identity:

```text
v1:platform:botId:groupId:messageId-or-eventId
```

URLs are data, never idempotency keys. Temporary playback URLs are refreshed during each delivery attempt and are not persisted.

## State Machines

Event jobs:

```text
pending -> processing -> completed
                    \-> retry_wait -> processing
                    \-> failed
```

Each event stores independent `recent`, `archive`, `media`, and `emoji` consumer states. Storage retries are idempotent by `event_id`; one consumer failure does not roll back successful consumers.

Delivery jobs:

```text
pending -> processing -> sent
                    \-> retry_wait -> processing
                    \-> failed
```

Jobs record attempts, retry time, lease owner, lease expiry, last error, OneBot retcode, uncertainty, and the final receipt. Locks use Redis compare-and-delete and compare-and-expire scripts. Recovery waits for an unexpired lease instead of stealing it from a live or hot-reloaded worker.

## Delivery Semantics

- Returned non-zero OneBot retcodes are known failures and may retry up to the configured limit.
- A thrown transport error or malformed/missing receipt has an unknown outcome. It becomes `failed` with `uncertain=true` and is not retried automatically.
- A confirmed `retcode=0` is persisted as `sent`; subsequent duplicate events reuse that state and do not send again.
- OneBot does not expose a general idempotency token. Therefore a process crash after OneBot accepted a message but before Redis persisted the receipt cannot be made strictly exactly-once. The pipeline minimizes this boundary and chooses no automatic retry whenever the outcome is uncertain.

## Ordering And Concurrency

- Raw capture is independent of app-plugin priority and returns immediately after scheduling Redis persistence.
- Event work is bounded globally and serialized by conversation where ordering matters.
- Media delivery is serialized by group and bounded across groups.
- Downloads, base64 conversion, and OneBot sends never hold the Yunzai app dispatcher.
- Emoji auto-collection uses its own bounded background semaphore and cannot delay recent/archive consumers.

## Failure Policy

| Failure | Result |
| --- | --- |
| Redis event create fails | Log capture failure; no business consumer fabricates success |
| Media metadata refresh fails | Use the persisted card snapshot |
| Cover/video assembly fails | Send stable information and page data with a visible degradation note |
| Recent Redis read fails | Retry; never overwrite history with an empty array |
| NDJSON retry | Identity index prevents duplicate append |
| Known OneBot retcode failure | Retry with backoff, then retain `failed` state |
| Unknown OneBot outcome | Retain `failed + uncertain`; do not auto-retry |
| Restart or hot reload | Recover pending work after its lease is available |

## Operations

- `.消息管道状态` shows event and delivery state counts plus recent failures.
- `.消息管道状态 <群号>` limits the view to one group.
- Startup must log `[MessagePipeline] 原始事件捕获、持久任务和媒体 outbox 已启动`.
- Redis keys use the `ytbot:message_pipeline:` prefix and expire according to `messagePipeline` configuration.
- Before deployment, stop only after active image jobs are zero, back up the plugin, remove obsolete recorder files, deploy without AppleDouble files, then restart once.

## Acceptance Gate

A release is not accepted from unit tests alone. Send the same real share to both target groups and verify, for each group:

1. a distinct event job exists;
2. a distinct delivery job exists;
3. the delivery reaches `sent`;
4. the receipt has `retcode=0` and a message ID;
5. one visible merged-forward message appears;
6. no old recorder or relay path emits a duplicate.

## Extension Rule

New media platforms implement four bounded operations: detect from serialized envelope data, refresh metadata, build relay segments, and format stable information. They enqueue through `MediaOutbox` and send through `DeliveryGateway`; they must not add another catch-all app plugin or retain the raw Yunzai event.

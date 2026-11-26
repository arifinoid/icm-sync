# icm-sync

Two-way sync for [ICM](https://github.com/rtk-ai/icm) (Infinite Context Memory).

ICM keeps its memories in a node-local SQLite file (`~/.local/share/icm/memories.db`),
so two machines never see the same memories. `icm-sync` puts a small canonical
store on a server and keeps every device's local database aligned with it.

The sync scope is exactly what an ICM client reads and writes: the `memories`
table. `icm topics`, `icm health`, `icm wake-up` and `icm recall-project` all
derive from that table, so syncing it gives full parity. `facts`, `feedback`,
`memoirs`, `sessions` and `transcript` are not synced; they are empty in a normal
installation and are not part of the recall path.

## Components

| Path | Purpose |
| --- | --- |
| `src/api` | Hono HTTP API + SQLite canonical store (runs on the server) |
| `src/sync` | Client CLI that pushes local changes and applies the snapshot |
| `src/shared` | Row/wire types, timestamp handling, conflict rules |

## Protocol

```
POST /v1/push      { device_id, rows[], deleted[] }
GET  /v1/snapshot  ?device_id=...      -> application/x-ndjson
GET  /v1/status
GET  /healthz                          (unauthenticated)
```

All `/v1` routes need `Authorization: Bearer $ICM_SYNC_TOKEN`.

Conflict resolution is last-write-wins per memory `id`, using the `updated_at`
timestamp ICM already maintains. Deletes carry the `updated_ms` the device last
saw, so a stale delete cannot erase a newer edit made elsewhere. Rows are upserted
into the local database, so ICM's FTS triggers keep the search index correct.

## Requirements

- Bun (developed against 1.4.x)
- Nothing else: the store is SQLite and the only runtime dependency is `hono`.

## Development

```sh
bun install
bun test
bun run typecheck
```

Run a local server:

```sh
ICM_SYNC_DB=./server.db ICM_SYNC_TOKEN=secret PORT=3999 bun run api
```

Sync a copy of a real database against it:

```sh
ICM_SYNC_URL=http://127.0.0.1:3999 \
ICM_SYNC_TOKEN=secret \
ICM_SYNC_DEVICE=laptop \
ICM_DB=./copy.db \
ICM_SYNC_STATE=./sync-state.json \
bun run sync full
```

## Deployment

`flake.nix` builds both entry points. The NixOS configuration in
[`arifinoid/nixos`](https://github.com/arifinoid/nixos) runs the API behind
nginx with TLS and installs the client as a systemd user timer on each machine.

## Known limitations

- `vec_memories` (sqlite-vec) is not rebuilt by the client: the extension is
  compiled into the ICM binary and cannot be loaded by `bun:sqlite`. Keyword
  recall is unaffected; semantic recall would need re-embedding by ICM.
- Sync is eventual. A device pushes and pulls on a timer (default: every 10
  minutes), so two devices editing the same memory within one interval resolve
  by last-write-wins on the next round.

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

ICM also derives a `summary_hash` from the normalized topic + summary and puts a
UNIQUE index on it, so one database cannot hold the same memory twice. Two
devices can still record that memory independently under different ids; the store
has no such constraint and keeps both. When applying a snapshot the client keeps
one row per `summary_hash` (the newest, so the choice is the same on every
device) and drops a local row that reuses the hash under another id. An id the
device then no longer has is reported as deleted on the next round, which removes
the duplicate from the store as well.

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

`flake.nix` builds both entry points as standalone executables, pinning the one
runtime dependency (hono) to its registry tarball so the Nix build never needs
network access. The NixOS configuration in
[`arifinoid/nixos`](https://github.com/arifinoid/nixos) runs the API behind
nginx with TLS and installs the client as a systemd user timer on each machine.

Server layout:

- `https://icm.arifinoid.web.id` proxied to `127.0.0.1:3998`
- canonical database `/var/lib/icm-sync/icm-sync.db`
- nightly `VACUUM INTO` dump to `/var/backups/icm-sync`, keeping 14 copies
- the shared bearer token is the sops key `icm_sync_token`, rendered into
  `/etc/icm-sync.env` on the server and `~/.config/icm-sync/env` on a client

Client layout: `icm-sync` runs every 10 minutes (systemd user timer) with
`ICM_SYNC_DEVICE` set to the host name, so `arifinoid` and `wsl-arifinoid`
appear as separate devices in `/v1/status`. Run `icm-sync full` by hand for an
initial one-shot sync.

The client reads its configuration from `~/.config/icm-sync/env` when the
variables are not already in the environment (override with
`ICM_SYNC_ENV_FILE`). The systemd unit passes the same file through
`EnvironmentFile`, so a manual run and a timer run behave identically; a value
exported in the shell always wins.

## Known limitations

- `vec_memories` (sqlite-vec) is not rebuilt by the client: the extension is
  compiled into the ICM binary and cannot be loaded by `bun:sqlite`. Keyword
  recall is unaffected; semantic recall would need re-embedding by ICM.
- Sync is eventual. A device pushes and pulls on a timer (default: every 10
  minutes), so two devices editing the same memory within one interval resolve
  by last-write-wins on the next round.

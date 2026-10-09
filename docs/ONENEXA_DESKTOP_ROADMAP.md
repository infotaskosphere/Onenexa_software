# OneNexa Desktop Foundation

This branch starts the Windows desktop packaging work for OneNexa. It is intentionally isolated from `feature/master-console`.

## Current phase and limitations

This is the first development foundation, not yet the complete offline-first product. The existing ERP request handlers still read and write through the MongoDB-backed data layer (`MONGO_URL` / `MONGODB_URI`). The local SQLite outbox added in `backend/local_first_store.py` is durable infrastructure only: existing ERP writes are not yet routed through it, and no cloud-sync worker or conflict-resolution workflow is connected. Do not describe the current branch as offline-ready or distribute it to customers.

The target is local-first operation: each workstation persists supported changes on its own disk, queues outbound changes, and synchronizes them to an authorized office/platform endpoint when connectivity returns. A separate office sync service may be required for multiple employees to share records while the internet is unavailable. This must be implemented with tenant isolation, authentication, idempotency, conflict handling, deletion propagation, document transfer, and tested recovery.

## Development

1. Install Node.js 20 or newer and Python 3.12 matching the existing deployment baseline.
2. Install project dependencies with `npm install` at the repository root.
3. Build the React frontend: `npm run build:frontend`.
4. Configure a **development-only** local backend/database in your environment. Do not use production customer credentials or data.
5. Launch the development desktop shell using `npm run desktop:dev`. This starts Vite and Electron; the existing Python backend and a real persistent ERP database must be configured separately.

The shell expects the local API to be available at `http://127.0.0.1:7432`. The current backend does not yet package or provision a local MongoDB server automatically. Do not distribute this build to customers as an offline-capable release.

## Implemented foundation

- Electron development launcher: `npm run desktop:dev`.
- Per-user local SQLite database path, overridable with `ONENEXA_DATA_DIR`.
- Durable outbound change queue with tenant/company scope, idempotency keys, retry metadata, acknowledgement marking, sync cursors, and queue status helpers.
- Unit tests for local-store creation, company scoping, idempotency, retry status, acknowledgements, cursors, and input validation (`python -m unittest tests.test_local_first_store`).

These helpers are not yet wired into the ERP's business write paths or exposed as sync APIs. The outbox currently reports sync disabled intentionally. Do not run it against production customer data as a substitute for a backup.

## Local-first pilot API (2026-10-09)

The first local record-storage slice is now present on `feature/master-console`:

- `backend/local_first_records.py` stores pilot `client` and `task` records in SQLite, scoped by the authenticated company.
- A record write and its outbox entry are committed in the same SQLite transaction.
- Deletes use local tombstones and queue a delete operation rather than erasing history immediately.
- `backend/local_first_router.py` exposes authenticated status, list, create/update, and delete endpoints under `/api/desktop/local-first`.
- GitHub Actions compiles these modules and runs local-first unit tests on pushes and pull requests to `feature/master-console`.

Important limitations remain: the existing ERP Clients and Tasks screens/APIs are still MongoDB-backed and do not automatically use these pilot endpoints. The sync queue has no cloud transport yet, so pending changes stay on the device. This is a backend pilot foundation, not a complete offline release. Use a development database and non-production test data.

## Next implementation gates

1. Run the unit tests and desktop development launch on a clean development PC.
2. Add authenticated local-store initialization and connect selected business write paths transactionally to the local store.
3. Add an allowlisted, tenant-scoped sync protocol with idempotent server acknowledgements and explicit conflict rules.
4. Synchronize remote changes back to the workstation and propagate deletions safely.
5. Add document/blob synchronization and secure credential storage.
6. Package the Python runtime and local database provisioning; test install, upgrade, rollback, backup/restore, and offline recovery before building a customer installer.

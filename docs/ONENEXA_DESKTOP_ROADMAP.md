# OneNexa Desktop Foundation

This branch starts the Windows desktop packaging work for OneNexa. It is intentionally isolated from `feature/master-console`.

## Current phase and limitations

This is a desktop-shell foundation, not yet the complete offline-first product. The existing FastAPI backend obtains its data layer from MongoDB via `MONGO_URL` / `MONGODB_URI`. A local Electron window alone does not make the application offline-capable.

Before commercial release, follow the implementation checklist in `docs/ONENEXA_DESKTOP_ROADMAP.md`, including local persistence, authenticated peer-to-peer synchronization, conflict resolution, and testing with the main office computer and internet switched off.

## Development

1. Install Node.js 20 or newer and Python 3.12 matching the existing deployment baseline.
2. Install project dependencies with `npm install` at the repository root.
3. Build the React frontend: `npm run build:frontend`.
4. Configure a **development-only** local backend/database in your environment. Do not use production customer credentials or data.
5. Launch the desktop shell using `npm run desktop:dev`.

The shell expects the local API to be available at `http://127.0.0.1:7432`. The current backend does not yet package or provision a local MongoDB server automatically. Do not distribute this build to customers as an offline-capable release.

## Packaging

After installing dependencies and building the frontend, run `npm run desktop:package` on Windows to generate an Electron installer for the shell. The installer is not a complete customer-ready offline bundle until the backend runtime and local database provisioning steps are implemented and validated.

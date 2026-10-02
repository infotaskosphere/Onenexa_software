# Taskosphere Commercial Frontend

This frontend is a React + Vite application.

## Development

From the repository root:

```bash
npm install
npm run dev
```

The Vite development server runs on port 3000 by default.

## Production build

```bash
npm run build
```

The production bundle is written to `frontend/dist`.

## Configuration

Set `VITE_API_URL` when the frontend and backend are hosted on different origins. When it is not set, the frontend uses a local backend during local development and a same-origin `/api` path for other deployments.

## Notes

Routing uses React Router and the production deployment is handled through the repository's Vercel integration.

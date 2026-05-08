# ChatApp

A full-featured real-time chat application — WhatsApp/Messenger/Telegram clone with instant messaging, voice/video calls, file sharing, and group chats.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port from $PORT)
- `pnpm --filter @workspace/chat-app run dev` — run the Vite frontend (port from $PORT)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — JWT signing secret

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + Socket.IO (real-time)
- Frontend: Vanilla JavaScript (no frameworks) + Vite
- DB: PostgreSQL + Drizzle ORM
- Auth: JWT (signed with SESSION_SECRET env var)
- File uploads: Multer → `/uploads/` directory → served at `/api/uploads/:filename`
- Real-time: Socket.IO at path `/api/socket.io`
- WebRTC: peer-to-peer voice/video calls via Socket.IO signaling
- Build: esbuild (API server CJS bundle)

## Where things live

- `lib/db/src/schema/` — DB schema (users, conversations, messages, participants, seen)
- `lib/api-zod/src/generated/api.ts` — Zod schemas for auth request bodies
- `artifacts/api-server/src/routes/` — Express route handlers (auth, users, conversations, messages, upload)
- `artifacts/api-server/src/middlewares/auth.ts` — JWT middleware + `requireAuth`
- `artifacts/api-server/src/index.ts` — Socket.IO server + WebRTC signaling
- `artifacts/chat-app/src/main.js` — Frontend entry point / router
- `artifacts/chat-app/src/pages/auth.js` — Login/register page
- `artifacts/chat-app/src/pages/chat.js` — Main chat UI (sidebar, messages, calls, emoji, modals)
- `artifacts/chat-app/src/lib/` — api.js, auth.js, socket.js, utils.js

## Architecture decisions

- Vanilla JS frontend (no React/Vue/Angular) built with Vite — keeps bundle small, full browser feature detection
- Socket.IO path set to `/api/socket.io` so the shared reverse proxy correctly routes both REST and WebSocket traffic under `/api`
- JWT stored in `localStorage`; Socket.IO auth uses the same token via `socket.handshake.auth.token`
- Optimistic message rendering: messages get a `tempId`, appear immediately, then get replaced when the socket echoes the server-confirmed message
- File uploads stored on disk at `artifacts/api-server/uploads/`; URL is `/api/uploads/<filename>` — no object storage required for dev

## Product

- Register / login with email + password
- Sidebar: list of conversations, search, unread badges, online indicators
- Direct messages and group chats
- Real-time messaging via Socket.IO — typing indicators, seen receipts
- Reply to, edit, and delete messages (with context menu / long-press)
- File sharing: images, videos, audio, documents
- Voice recording (MediaRecorder API)
- Voice and video calls via WebRTC (peer-to-peer, STUN servers)
- Emoji picker with search
- Dark mode (persisted to localStorage)
- Location sharing
- Browser feature detection with graceful fallback warnings
- Push notifications (Notification API, requests permission on first load)
- Mobile-responsive layout (full-screen transitions on small screens)
- Profile panel (click conversation header to open)
- Settings modal: edit username, bio, avatar, dark mode toggle, sign out

## User preferences

- Vanilla JavaScript only — no React/Angular/Vue on the frontend
- All features must degrade gracefully on older browsers (use `featureCheck()` and `showFeatureWarning()`)

## Gotchas

- The Socket.IO server listens at path `/api/socket.io` — the artifact.toml must route both `/api` and `/api/socket.io`
- `pnpm --filter @workspace/db run push` must be re-run after any schema change in `lib/db/src/schema/`
- The api-server `index.ts` creates the HTTP server directly (wraps `app`) so Socket.IO can share it — don't use `app.listen()` in `app.ts`
- `RegisterBody` and `LoginBody` come from `@workspace/api-zod` (generated from OpenAPI spec)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

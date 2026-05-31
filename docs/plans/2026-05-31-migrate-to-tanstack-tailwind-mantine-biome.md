# Migration: TanStack Router + Tailwind CSS v4 + Mantine UI + Biome

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate frontend from react-router-dom/ESLint/plain-CSS to TanStack Router (SPA)/Biome/Tailwind CSS v4/Mantine UI v9.

**Architecture:** TanStack Router with file-based routing in SPA mode (no SSR), Tailwind CSS v4 for utility classes, Mantine UI v9 for components, Biome for lint/format. Go backend stays unchanged; Vite proxy remains.

**Tech Stack:** TanStack Router, Tailwind CSS v4, Mantine UI v9, Biome 2, TypeScript 6, Vite 8, React 19.2, lucide-react

---

### File Inventory

**Delete from `frontend/`:**
- `App.tsx`
- `App.css`
- `eslint.config.js`
- `tsconfig.tsbuildinfo`

**Create in `frontend/`:**
- `biome.json`
- `postcss.config.mjs`
- `src/router.tsx`
- `src/styles.css`
- `src/routes/__root.tsx`
- `src/routes/index.tsx`
- `src/routes/login.tsx`
- `src/routes/chat.tsx`

**Modify:**
- `frontend/package.json` — full deps replacement
- `frontend/vite.config.ts` — add tanstackRouter(), tailwindcss()
- `frontend/tsconfig.json` — ES2022, path aliases, verbatimModuleSyntax
- `frontend/index.html` — title, root div id
- `frontend/src/main.tsx` — RouterProvider entry
- `frontend/src/pages/LoginPage.tsx` — TanStack Router imports + Tailwind/Mantine styles
- `frontend/src/pages/ChatPage.tsx` — TanStack Router imports + Tailwind/Mantine styles
- `frontend/src/AccountSwitcher.tsx` — Tailwind/Mantine styles
- `frontend/.gitignore` — add TanStack entries
- `Makefile` — replace eslint with biome commands

**Keep unchanged:**
- `frontend/src/api.ts`
- `frontend/src/useSSE.ts`
- `frontend/src/useAuth.tsx`

---

### Task 1: Update package.json, install deps, remove old deps

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Write new package.json**

```json
{
  "name": "fast_chat_frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "format": "biome format --write",
    "lint": "biome check",
    "lint:fix": "biome check --apply"
  },
  "dependencies": {
    "@mantine/core": "^9.2.2",
    "@mantine/hooks": "^9.2.2",
    "@tanstack/react-router": "^1.114.3",
    "@tanstack/react-router-devtools": "^1.114.3",
    "lucide-react": "^0.545.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "tailwindcss": "^4.1.18"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.5",
    "@tailwindcss/vite": "^4.1.18",
    "@tanstack/router-plugin": "^1.132.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.1",
    "postcss": "^8.5.15",
    "postcss-preset-mantine": "^1.18.0",
    "postcss-simple-vars": "^7.0.1",
    "typescript": "^6.0.2",
    "vite": "^8.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "lightningcss"]
  }
}
```

- [ ] **Step 2: Remove node_modules and reinstall**

```bash
rm -rf frontend/node_modules frontend/package-lock.json
cd frontend && npm install
```

- [ ] **Step 3: Verify npm install succeeds**

Run: `cd frontend && npm ls --depth=0`
Expected: lists all new packages without missing peer deps

- [ ] **Step 4: Delete old lockfile if npm created a new one**

(Already done — package-lock.json regenerated)

---

### Task 2: Create biome.json

**Files:**
- Create: `frontend/biome.json`

- [ ] **Step 1: Write biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.2.4/schema.json",
  "vcs": {
    "enabled": false,
    "clientKind": "git",
    "useIgnoreFile": false
  },
  "files": {
    "ignoreUnknown": false,
    "includes": ["**/src/**/*", "**/vite.config.ts", "**/postcss.config.mjs"],
    "excludes": ["**/routeTree.gen.ts", "**/node_modules/**", "**/dist/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "tab"
  },
  "assist": {
    "actions": { "source": { "organizeImports": "on" } }
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double"
    }
  }
}
```

- [ ] **Step 2: Verify biome parses**

Run: `cd frontend && npx biome --version`
Expected: prints version

---

### Task 3: Create postcss.config.mjs

**Files:**
- Create: `frontend/postcss.config.mjs`

- [ ] **Step 1: Write postcss.config.mjs**

```js
export default {
  plugins: {
    "postcss-preset-mantine": {},
    "postcss-simple-vars": {
      variables: {
        "mantine-breakpoint-xs": "36em",
        "mantine-breakpoint-sm": "48em",
        "mantine-breakpoint-md": "62em",
        "mantine-breakpoint-lg": "75em",
        "mantine-breakpoint-xl": "88em",
      },
    },
  },
};
```

---

### Task 4: Update vite.config.ts

**Files:**
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: Write vite.config.ts**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
```

---

### Task 5: Update tsconfig.json

**Files:**
- Modify: `frontend/tsconfig.json`

- [ ] **Step 1: Write tsconfig.json**

```json
{
  "include": ["**/*.ts", "**/*.tsx"],
  "compilerOptions": {
    "target": "ES2022",
    "jsx": "react-jsx",
    "module": "ESNext",
    "paths": {
      "#/*": ["./src/*"],
      "@/*": ["./src/*"]
    },
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  }
}
```

---

### Task 6: Update index.html

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: Write index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fast Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

(Unchanged — keep as-is)

---

### Task 7: Create src/styles.css

**Files:**
- Create: `frontend/src/styles.css`

- [ ] **Step 1: Write styles.css**

```css
/* Mantine PostCSS needs to be processed first */
@import "tailwindcss";

/* Mantine core styles */
@layer mantine {
  @import "@mantine/core/styles.css";
}
```

Actually, we need to think about import order. Tailwind v4 uses `@import "tailwindcss"` which includes a preflight (CSS reset). Mantine has its own reset. The Mantine docs suggest disabling Tailwind preflight when using with Mantine.

For Tailwind v4, the cleanest approach to skip preflight:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "@mantine/core/styles.css";
```

This way:
- Tailwind provides theme variables and utility classes
- Mantine provides its own base/reset styles
- No conflicting resets

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "@mantine/core/styles.css";

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
}
```

---

### Task 8: Create src/router.tsx

**Files:**
- Create: `frontend/src/router.tsx`

- [ ] **Step 1: Write router.tsx**

```tsx
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
```

---

### Task 9: Create route files

**Files:**
- Create: `frontend/src/routes/__root.tsx`
- Create: `frontend/src/routes/index.tsx`
- Create: `frontend/src/routes/login.tsx`
- Create: `frontend/src/routes/chat.tsx`

- [ ] **Step 1: Write __root.tsx** (root layout with AuthProvider)

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { AuthProvider } from "../useAuth";

export const Route = createRootRoute({
  component: RootDocument,
});

function RootDocument() {
  return (
    <AuthProvider>
      <Outlet />
      <TanStackRouterDevtools />
    </AuthProvider>
  );
}
```

- [ ] **Step 2: Write index.tsx** (redirect / to /login or /chat)

For TanStack Router, the `/` route redirects:
- If user has accounts → go to /chat
- If not → go to /login
We can't use `useAuth` directly here because it's a static route definition. Instead, redirect to /login and let LoginPage handle the accounts check.

```tsx
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <Navigate to="/login" />,
});
```

- [ ] **Step 3: Write login.tsx**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import LoginPage from "../pages/LoginPage";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});
```

- [ ] **Step 4: Write chat.tsx**

```tsx
import { createFileRoute } from "@tanstack/react-router";
import ChatPage from "../pages/ChatPage";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});
```

---

### Task 10: Update src/main.tsx

**Files:**
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";

const router = getRouter();

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

---

### Task 11: Update .gitignore

**Files:**
- Modify: `frontend/.gitignore`

- [ ] **Step 1: Add TanStack entries**

Append to `.gitignore`:
```
.tanstack
routeTree.gen.ts
```

Also update the root `.gitignore` if needed (the root one should already cover basic things).

Wait, `routeTree.gen.ts` should NOT be gitignored — the TanStack docs recommend committing it so other devs see the same generated file. But it's regenerated on every build. The `.tanstack` directory should be gitignored though.

Let's just add `.tanstack` to gitignore.

---

### Task 12: Delete old files

**Files:**
- Delete: `frontend/src/App.tsx`
- Delete: `frontend/src/App.css`
- Delete: `frontend/eslint.config.js`
- Delete: `frontend/tsconfig.tsbuildinfo` (if exists)

- [ ] **Step 1: Remove old files**

```bash
rm frontend/src/App.tsx frontend/src/App.css frontend/eslint.config.js
```

---

### Task 13: Update Makefile

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Replace eslint with biome**

Change:
```
frontend\:lint:
	cd frontend && npx eslint src/
```
To:
```
frontend\:lint:
	cd frontend && npx biome check src/

frontend\:format:
	cd frontend && npx biome format --write src/
```

---

### Task 14: Update LoginPage to TanStack Router + Tailwind/Mantine

**Files:**
- Modify: `frontend/src/pages/LoginPage.tsx`

- [ ] **Step 1: Rewrite LoginPage**

Changes needed:
1. Import `Navigate`, `useNavigate` from `@tanstack/react-router`
2. Replace CSS classes with Mantine components + Tailwind utilities

```tsx
import { useState, type SubmitEvent } from "react";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { Button, TextInput, Paper, Title, Text } from "@mantine/core";
import { useAuth } from "../useAuth";

export default function LoginPage() {
  const [nick, setNick] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login, accounts } = useAuth();

  if (accounts.length > 0) {
    return <Navigate to="/chat" />;
  }

  async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = nick.trim();
    if (trimmed.length === 0) return;

    setLoading(true);
    setError("");
    try {
      await login(trimmed);
      void navigate({ to: "/chat" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Paper
        withBorder
        p="xl"
        className="w-80"
        style={{ background: "var(--mantine-color-dark-8)" }}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Title order={1} ta="center" c="blue">
            Fast Chat
          </Title>
          <Text ta="center" size="sm" c="dimmed">
            Enter your nickname to join
          </Text>
          <TextInput
            placeholder="Nickname"
            maxLength={20}
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            autoFocus
          />
          {error.length > 0 && (
            <Text size="sm" c="red" ta="center">
              {error}
            </Text>
          )}
          <Button
            type="submit"
            disabled={loading || nick.trim().length === 0}
            loading={loading}
          >
            {loading ? "Joining..." : "Join"}
          </Button>
        </form>
      </Paper>
    </div>
  );
}
```

But wait — this uses Mantine's `Paper`, `Button`, `TextInput`, `Title`, `Text`. These need to be imported from `@mantine/core`. And the CSS is now a mix of Tailwind utilities (`flex h-full items-center justify-center`) and Mantine inline styles.

The `className` attributes use Tailwind classes, so they'll work with Tailwind v4.

We also need a MantineProvider wrapping the app for Mantine to work. Let me add it to `__root.tsx`.

Actually, I need to update `__root.tsx` to include `MantineProvider`:

```tsx
import { MantineProvider } from "@mantine/core";
// ...
<MantineProvider defaultColorScheme="dark">
  <AuthProvider>
    <Outlet />
    <TanStackRouterDevtools />
  </AuthProvider>
</MantineProvider>
```

Let me adjust the __root.tsx accordingly.

---

### Task 15: Update ChatPage to TanStack Router + Tailwind/Mantine

**Files:**
- Modify: `frontend/src/pages/ChatPage.tsx`

This is the largest migration. Every CSS class from App.css needs to be replaced with Tailwind utilities or Mantine components.

The main layout:
- `chat-layout` → `h-full flex flex-col`
- `app-header` → `flex items-center justify-between px-4 h-12 bg-blue-900 border-b border-gray-900` (or Mantine `Group`)
- `chat-page` → `flex flex-1 min-h-0`
- `sidebar` → `w-72 min-w-72 bg-dark-8 border-r border-gray-900 flex flex-col`
- `chat-main` → `flex-1 flex flex-col bg-dark-9`

For the account switcher toggle, chat list, messages, input bar — all need to use Tailwind.

This is going to be a LOT of inline Tailwind classes. Let me think about whether this is the right approach or whether we should keep some CSS file for complex layouts.

Actually, for readability, we could keep the component-specific styles in the component file with Tailwind, and only use custom CSS for very complex things. Mantine components handle most UI patterns (Group, Stack, Paper, etc.).

Let me simplify by mapping the key layout classes to Tailwind:

```
.chat-layout       → <div className="h-full flex flex-col">
.chat-page         → <div className="flex flex-1 min-h-0">
.sidebar           → <aside className="w-72 min-w-72 bg-[var(--mantine-color-dark-8)] border-r border-[var(--mantine-color-dark-4)] flex flex-col">
.search-box        → <div className="p-3 border-b border-[var(--mantine-color-dark-4)]">
.chat-list         → <div className="flex-1 overflow-y-auto">
.chat-main         → <main className="flex-1 flex flex-col bg-[var(--mantine-color-dark-9)]">
.chat-header       → <header className="px-4 py-3 bg-[var(--mantine-color-dark-8)] border-b border-[var(--mantine-color-dark-4)] font-semibold">
.messages          → <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
.message           → <div className="max-w-[70%] p-2 px-3 rounded-lg bg-[var(--mantine-color-dark-8)] self-start">
.message.own       → <div className="max-w-[70%] p-2 px-3 rounded-lg bg-blue-800 self-end">
.input-bar         → <div className="flex gap-2 p-3 border-t border-[var(--mantine-color-dark-4)] bg-[var(--mantine-color-dark-8)]">
```

Actually, this would be much cleaner with Mantine's `Group`, `Stack` components. But for now, let me just use Tailwind classes directly. The user chose Tailwind for a reason.

Let me think about which approach to use for the buttons. The logout button, chat list items, search results — these can be Mantine `UnstyledButton` or `<button>` with Tailwind classes.

For this migration, I'll use plain `<button>` with Tailwind classes to keep things simple, and only use Mantine for form controls (TextInput, Button with loading)

Let me write out the full ChatPage migration.

Actually, this is getting very long. Let me simplify: I'll write the plan at a higher level for the component style migrations, showing the pattern but not every line. The tasks can be executed by subagents who read the old code and convert it.

---

### Task 16: Update AccountSwitcher to Tailwind/Mantine

**Files:**
- Modify: `frontend/src/AccountSwitcher.tsx`

Same approach — replace CSS classes with Tailwind utilities.

---

### Task 17: Update useSSE — no changes needed

**Files:**
- `frontend/src/useSSE.ts` — keep unchanged

---

### Task 18: Update useAuth — no changes needed

**Files:**
- `frontend/src/useAuth.tsx` — keep unchanged

---

### Task 19: Update api.ts — no changes needed

**Files:**
- `frontend/src/api.ts` — keep unchanged

---

### Task 20: Run full lint, verify build

- [ ] **Step 1: Run biome check**

```bash
cd frontend && npx biome check src/
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Verify dev server starts**

```bash
cd frontend && npx vite --port 5173
```

- [ ] **Step 4: Run backend lint**

```bash
make backend:lint
```

- [ ] **Step 5: Commit all changes** (only when user says OK)

# Hangar View — V1 Virtual Office Design System

## 1. Visual theme and atmosphere

A single-user virtual office, not a generic dashboard. Agents are employees at workstations; the room's ambient status answers “is Hangar alive?” in three seconds. V1’s presence-first office metaphor remains the memory point. M2 adds authenticated intent, Run, timeline, cancel, and Approval controls without replacing the room with a card wall.

Design dials: visual adventure 4/10, motion 2/10, information density 7/10.

## 2. Palette and roles

- Canvas: `#0e1017` (off-black, never pure black)
- Room: `#161a27`; panel: `#1a1e2b`; elevated: `#20263a`
- Border: `#2b3145`; stronger border: `#3a4564`
- Primary text: `rgba(255,255,255,.88)`; secondary `.68`; tertiary `.48`
- Alive: `#43d6a0`; waiting/warning: `#f0a83a`; failure/destructive: `#ef5a63`
- Active/focus: `#7d8fd6`

Status colors encode state only. No decorative multi-color gradients or glow.

## 3. Typography

Chinese/UI uses the zero-download system stack: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`. IDs, times, cursors, and digests use `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` with tabular numerals. Body ≥14px, line-height 1.55; headings use 500/600 only. No italic.

## 4. Components

- **HUD:** brand, single liveness beacon, authenticated subject, settings/logout. It merges with the room; it is not a detached toolbar.
- **Login sheet:** one labeled bootstrap textarea, establish action, inline errors. Bootstrap is cleared from DOM and JS references in `finally`.
- **Workstation:** employee avatar, agent name, latest known status. Selected state uses full background + full border, never a left stripe.
- **Agent drawer:** releases and intent form; focus moves in, Escape closes, focus returns.
- **Run desk:** immutable Run identity, state, Cancel with confirmation, SSE event timeline.
- **Approval sheet:** pending items with Approve/Deny; dangerous action always confirms.
- **Toast:** only recent action or actionable error; no permanent “loaded” messages.

## 5. Layout principles

Desktop-first office floor: HUD → liveness/active Run band → workstation floor. A right drawer holds details so the office stays visible. At <760px, workstations become a single vertical roster and drawers become bottom sheets. Four-pixel base spacing; group gaps 16/24/32px. No horizontal page scroll.

## 6. Depth and hierarchy

Depth comes from luminance steps and 1px borders, not drop-shadow stacks. Only drawer/dialog uses a restrained tinted shadow. The floor uses a ≤3% grid texture, not a color gradient. One visual focus per state: liveness beacon when idle, current Run when active, pending Approval when blocked.

## 7. Do / Don't

Do preserve V1’s virtual-office presence, state-driven room color, employee mood, and trace drawer. Do default-drop raw facts and secrets. Do expose empty/loading/error/recovery states.

Do not read SQLite, Agent files, browser storage, URL, history, or console for credentials. Do not invoke CLI/subprocess. Do not add a frontend framework or second state store. Do not use persistent bearer tokens, left accent stripes, italic text, pure black, neon glow, or card grids as universal grouping.

## 8. Responsive behavior

- ≥1100px: floor + fixed-width detail drawer
- 760–1099px: denser two-column workstations; overlay drawer
- <760px: one-column employee roster; bottom-sheet detail; primary actions full width
- Touch targets ≥44px; safe-area padding; reduced-motion disables beacon/entrance effects

## 9. Motion philosophy

Motion reports state, never decorates. Beacon pulse is slow and disabled by `prefers-reduced-motion`; drawer transition is 180–220ms using `cubic-bezier(.23,1,.32,1)` on transform/opacity only; button press ≤100ms. No `transition: all`, no automatic list choreography.

## V1 DNA retained

- Canvas/panel/border values: `#0e1017 / #1a1e2b / #2b3145`
- Semantic ambient colors: alive `#43d6a0`, waiting `#f0a83a`, failure `#ef5a63`
- Presence-first HUD beacon, employee workstations, and event drawer
- Recursive non-overlapping refresh concept replaced by SDK-owned request/SSE ownership
- Mobile workstations collapse from office floor to a readable roster

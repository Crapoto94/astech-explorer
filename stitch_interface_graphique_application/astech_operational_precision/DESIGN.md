---
name: ASTECH Operational Precision
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#434655'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#747686'
  outline-variant: '#c4c5d7'
  surface-tint: '#2151da'
  primary: '#0037b0'
  on-primary: '#ffffff'
  primary-container: '#1d4ed8'
  on-primary-container: '#cad3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#565e74'
  on-secondary: '#ffffff'
  secondary-container: '#dae2fd'
  on-secondary-container: '#5c647a'
  tertiary: '#5700c0'
  on-tertiary: '#ffffff'
  tertiary-container: '#712ae2'
  on-tertiary-container: '#dfccff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dce1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001551'
  on-primary-fixed-variant: '#0039b5'
  secondary-fixed: '#dae2fd'
  secondary-fixed-dim: '#bec6e0'
  on-secondary-fixed: '#131b2e'
  on-secondary-fixed-variant: '#3f465c'
  tertiary-fixed: '#eaddff'
  tertiary-fixed-dim: '#d2bbff'
  on-tertiary-fixed: '#25005a'
  on-tertiary-fixed-variant: '#5a00c6'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 2rem
    fontWeight: '700'
    lineHeight: 2.5rem
  headline-lg:
    fontFamily: Inter
    fontSize: 1.5rem
    fontWeight: '600'
    lineHeight: 2rem
  headline-lg-mobile:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
  headline-md:
    fontFamily: Inter
    fontSize: 1.25rem
    fontWeight: '600'
    lineHeight: 1.75rem
  headline-sm:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '600'
    lineHeight: 1.5rem
  title-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '600'
    lineHeight: 1.25rem
  title-sm:
    fontFamily: Inter
    fontSize: 0.75rem
    fontWeight: '600'
    lineHeight: 1rem
  body-lg:
    fontFamily: Inter
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: 1.5rem
  body-md:
    fontFamily: Inter
    fontSize: 0.875rem
    fontWeight: '400'
    lineHeight: 1.25rem
  body-sm:
    fontFamily: Inter
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: 1.125rem
  label-mono-lg:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
    fontWeight: '500'
    lineHeight: 1.25rem
  label-mono-md:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: '500'
    lineHeight: 1rem
  label-mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: '500'
    lineHeight: 0.875rem
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-lg: 1.5rem
  margin: 1.25rem
  margin-mobile: 0.75rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

The design system establishes a high-performance, mission-critical workspace tailored for database administrators, plant engineers, maintenance directors, and technical operations leads interacting with enterprise Oracle ASTECH records. The aesthetic balances enterprise rigor with modern software velocity: high visual density, deliberate hierarchy, absolute data clarity, and uncompromised precision.

Drawing inspiration from contemporary technical platforms and professional ERP/GMAO administrative consoles, the system employs structured information architecture, utilitarian surfaces, and clear visual signposting. The user experience prioritizes rapid scanability, audit accountability, safe execution flows (dry-run previews, staging diffs, batch verification), and zero latency perception through unambiguous typographic rhythm and deterministic state feedback.

## Colors

The palette grounds the interface in stable industrial slates while reserving expressive chroma strictly for semantic, transactional, and operational indicators.

### Surface & Frame Tokens
- **Canvas Base:** `#f1f5f9` (Slate-100) — Delivers optimal optical contrast against elevated white panels without harsh terminal glare.
- **Card / Surface Container:** `#ffffff` (Pure White) — Encapsulates dense data grids, metric widgets, and flyout inspectors.
- **Header / Command Frame:** `#0f172a` (Slate-900) — Anchors global navigation, session metadata, database instance pills, and environmental state banners with text calibrated to `#cbd5e1` (Slate-300).
- **Hairlines & Dividers:** `#e2e8f0` (Slate-200) for interior layout boundaries; `#cbd5e1` (Slate-300) for interactive control edges.

### Typography & Content Inks
- **Primary Ink:** `#0f172a` (Slate-900) — Deep slate delivering AAA contrast for tabular numerals, column headers, and primary values.
- **Secondary Ink:** `#64748b` (Slate-500) — Muted descriptor text, field labels, metadata stamps, and column units.
- **Tertiary Ink:** `#94a3b8` (Slate-400) — Disabled indicators, placeholder text, and subtle grid crosshairs.

### Functional & ASTECH Lifecycle Status Matrix
- **Planned / Scheduled:** `#2563eb` (Blue-600) on `#eff6ff` (Blue-50) tint.
- **Overdue / Critical Alert:** `#dc2626` (Red-600) on `#fef2f2` (Red-50) tint.
- **Impending / Warning:** `#d97706` (Amber-600) on `#fffbeb` (Amber-50) tint.
- **Issued / Active Success:** `#16a34a` (Green-600) on `#f0fdf4` (Green-50) tint.
- **Mandated / Regulatory:** `#7c3aed` (Purple-600) on `#faf5ff` (Purple-50) tint.
- **To Create in ASTECH (Sync Addition):** `#059669` (Emerald-600) on `#ecfdf5` (Emerald-50) tint with solid green-600 left accent line.
- **To Deactivate in ASTECH (Sync Teardown):** `#b91c1c` (Crimson-700) on `#fef2f2` (Red-50) tint with strikethrough glyph indicators.
- **Concordant / Synchronized Neutral:** `#64748b` (Slate-500) on `#f8fafc` (Slate-50) tint.

## Typography

The type system pairs **Inter** for user interface controls, form labels, and natural prose with **JetBrains Mono** for asset codes, ASTECH entity IDs, SQL timestamps, hex dumps, and diff hashes.

### Tabular Formatting Rules
- Always activate numeric tabular lining (`font-feature-settings: "tnum" 1, "cv05" 1`) across all table cells and KPI readouts to prevent column jittering during real-time data syncs.
- Monospace tokens (`label-mono-*`) must be applied to all Oracle primary keys, Work Order codes (e.g., `WO-2024-8849`), equipment IDs, and dry-run execution manifests.
- Column headers utilize `title-sm` with explicit uppercase transform (`text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;`).

## Layout & Spacing

The interface implements a dual-structure layout: a fixed 240px navigation shell collapsing to a 56px utility icon strip on medium breakpoints, driving a fluid data-grid stage spanning up to 1920px container bounds.

### Responsive Breakpoints & Reflow Rules
- **Desktop (≥ 1280px):** 12-column layout. High-density metrics appear in 4-column groupings. Data tables provide side-by-side record comparison and sliding inspector drawers. Gutter width is fixed at `1.5rem` (`gutter-lg`).
- **Tablet / Workstation Small (768px – 1279px):** 8-column layout. Metric bands collapse to 2x2 configurations. Left navigation shifts into an off-canvas drawer or compact iconography bar. Table headers activate horizontal scroll with frozen primary identification columns. Gutter width is `1rem` (`gutter`).
- **Mobile (< 768px):** Single-column stack. Data grids transform into stacked summary cards displaying status badge, primary asset ID, and single-tap dry-run triggers. Margin defaults to `0.75rem` (`margin-mobile`).

### Density & Compactness Standard
To accommodate high-throughput GMAO supervision without visual clutter, inner component vertical paddings follow a compact baseline (`space-sm` to `space-md` for standard table rows; `space-xs` for dense auditing logs).

## Elevation & Depth

Visual separation relies primarily on crisp boundary definitions, intentional chromatic changes across surfaces, and restrained ambient diffusion rather than deep dramatic drops.

- **Level 0 (Canvas Base):** Grounded `#f1f5f9` with zero shadow.
- **Level 1 (Card & Module Layer):** White `#ffffff` background bounded by a 1px solid `#e2e8f0` stroke. Subtle ambient drop: `box-shadow: 0 1px 3px 0 rgba(15, 23, 42, 0.05), 0 1px 2px -1px rgba(15, 23, 42, 0.03)`.
- **Level 2 (Active Panels & Hover Highlights):** Elevated table rows during batch selection and hovered cards: `box-shadow: 0 4px 6px -1px rgba(15, 23, 42, 0.07), 0 2px 4px -2px rgba(15, 23, 42, 0.04)`.
- **Level 3 (Popovers, Filter Menus, Segment Selectors):** Flyouts and context menus use: `box-shadow: 0 10px 15px -3px rgba(15, 23, 42, 0.1), 0 4px 6px -4px rgba(15, 23, 42, 0.05)` encased in a 1px `#cbd5e1` outline.
- **Level 4 (Audit Modals & Dry-Run Confirmation Dialogs):** Centered floating modals over a 40% `#0f172a` backdrop veil: `box-shadow: 0 20px 25px -5px rgba(15, 23, 42, 0.15), 0 8px 10px -6px rgba(15, 23, 42, 0.08)`.

## Shapes

The geometric architecture balances modern ergonomics with functional compactness:
- **Base Surfaces & Inputs:** 8px (`0.5rem`) corner radius applied across input controls, table wrappers, modal containers, and metric tiles.
- **Segmented Control Hubs & Action Buttons:** 8px (`0.5rem`) keeping buttons robust, clickable, and visually anchored.
- **Badges, Pills, and Audit Indicators:** Fully rounded (`rounded-full`, 9999px) for lifecycle badges and numeric counts to distinguish metadata tags from actionable rectangular buttons.
- **Nested Inner Elements:** Internal elements (such as individual segments in a control group or nested tabs) strictly use 6px (`0.375rem`) to maintain parallel border radii.

## Components

### Buttons & Transactional Actions
- **Primary Action (Commit / Push to ASTECH):** `#1d4ed8` fill, white bold text, subtle 1px border (`#1e40af`). On hover: `#1e40af`. Active state transitions to `#172554`.
- **Dry-Run / Simulation Action:** Surface `#ffffff` with a dashed 1.5px `#2563eb` border and `#1d4ed8` text. Accompanied by a science/beaker micro-icon. Shows instantaneous simulated records impact on hover.
- **Destructive Action (Deactivate Entity):** Surface `#ffffff` with `#dc2626` text and `#fecaca` border. Confirmed state shifts to `#dc2626` fill with white text.
- **Secondary / Utility Button:** Surface `#ffffff` with 1px `#e2e8f0` border and `#0f172a` text. Hover brings `#f8fafc` background with `#cbd5e1` edge.

### Status Badges & Lifecycle Pills
- Compact height (20px to 24px), utilizing `label-mono-sm` typography.
- Built using dual token rendering: 12% opacity color background with solid saturated color foreground and a subtle 20% opacity border matching the text tint.
- *ASTECH Sync Badges:* Include leading icons: `+` for "To Create" (emerald), `×` for "To Deactivate" (crimson), and `✓` for "Concordant" (slate).

### Data Tables (High Density)
- Column header strip: `#f8fafc`, 32px height, 1px bottom border `#e2e8f0`.
- Row height: 40px standard, 32px condensed mode. Alternating subtle zebra striping optional; preferred model is transparent row with 1px `#f1f5f9` dividing lines and `#f8fafc` hover fill.
- Left-most column reserved for multi-record selection checkboxes with sticky alignment.

### Metric KPI Cards
- Container: White surface with 1px `#e2e8f0` border, 8px padding internal `space-md` to `space-lg`.
- Top row: `title-sm` secondary label accompanied by an entity icon.
- Center value: 28px bold tabular number in `#0f172a`.
- Bottom trend marker: Mini inline sparkline or pill indicating drift/delta (e.g., `+14.2% overdue` in red pill, `0 sync conflicts` in green pill).

### Input Fields & Search Bars
- Background `#ffffff`, border 1px `#cbd5e1`, 36px standard control height.
- Focus ring: 2px offset-free outer glow in `#93c5fd` (`rgba(37, 99, 235, 0.25)`) with `#1d4ed8` primary border stroke.
- Global entity search: Incorporates keyboard hint token (`⌘K` or `Ctrl+K`) in `label-mono-sm` aligned to the right.

### Segmented Controls & Navigation Tabs
- Segmented container uses `#e2e8f0` track with 4px inner padding. Selected segment raises onto `#ffffff` card with 6px radius and Level 1 elevation shadow.
- Tab bars utilize bottom horizontal highlight line (2px height in `#1d4ed8`) positioned over 1px `#e2e8f0` continuous base rule.
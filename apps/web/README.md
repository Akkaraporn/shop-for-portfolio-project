# web

The React storefront. Task 3.0 built its design foundation; the pages arrive with
3.3 and 3.4.

```bash
npm run dev         # http://localhost:5173, /api proxied to the gateway on :8080
npm run build
npm test            # design-token guards
npm run typecheck
```

`npm run dev` currently renders the **design system** — every token, component and
non-happy-path state on one page. That is deliberate: the tokens get looked at before
anything is built on them, and the page stays afterwards as the place to check a
token change.

Run the API alongside it:

```bash
make up-node        # from the repo root
```

Vite proxies `/api` to `http://localhost:8080`, so the browser sees one origin in
development just as it does in production behind the nginx gateway. No CORS is
configured anywhere, because in the deployed system there is none to configure.

## Where the design decisions live

[`docs/design-refs/`](../../docs/design-refs/) — the reference analysis, the token
rationale, and four wireframes. Read that before adding a page.

## Tokens

In [`src/index.css`](src/index.css) under `@theme`. Tailwind v4 is CSS-first, so
there is no `tailwind.config.ts`: tokens are declared once in CSS and generate both
the utilities and the variables.

One neutral ramp, one brand ramp, three semantics, two radii, two shadows, and six
spacing steps used out of Tailwind's scale.

## Thai text

**Never use `leading-tight`, `leading-none`, or any leading below 1.35.** Thai stacks
an upper vowel and a tone mark above the base character and hangs some vowels below
it; a line box sized for Latin clips them, and the result is readable enough that it
is easy to miss.

Every size in the type scale carries its own line-height — 1.6 for body, never below
1.35 for headings — and `npm test` fails if a tight leading appears anywhere in
`src/`. It caught three shadcn components on the day it was written.

## Tests

`src/design-tokens.spec.ts` asserts the things that are easy to regress by accident:

- every type size declares a line-height, body at 1.6, nothing below 1.35
- no tight-leading utility anywhere in the source
- **WCAG AA contrast**, computed by converting the oklch tokens to luminance rather
  than checked once in devtools
- the palette stays small: two ramps, two radii, two shadows

## Adding a shadcn component

```bash
npx shadcn@latest add <name>
```

Then check two things, because the CLI gets both wrong here:

1. It writes `import { cn } from "cn"` — an unrelated npm package — instead of
   `@/lib/utils`. Repoint it, and remove `cn` from `package.json` if it was added.
2. Its components often carry `leading-none`. `npm test` will fail; remove the class
   rather than the test.

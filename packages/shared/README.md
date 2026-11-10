# @daocut/shared

Shared chat types and helpers: turns, public events, agent activity, prompt references, title limits and Markdown parsing.

```ts
import { buildPromptDisplay, type Turn } from '@daocut/shared';
import { scanMarkdownBlocks } from '@daocut/shared/markdown';
```

This is a private workspace package bundled into the desktop app. Run `pnpm --filter @daocut/shared test` or `pnpm --filter @daocut/shared typecheck` from the repository root.

Part of [Daocut](https://github.com/stonele01/Daocut), distributed under the repository's [MIT license](../../LICENSE).

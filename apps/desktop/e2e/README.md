# Desktop end-to-end tests

Playwright driving a real Electron build (`_electron`) — the only place in the repo that
launches a window. Run with `pnpm test:e2e`; excluded from `pnpm test`.

What belongs here (REPO_SKELETON.md §5.3, Tier 5):

- State machine transitions from ui-design §3.1, including barge-in and Esc-cancel
- The ≤100 ms key-down → chip-visible budget
- Hidden renders no window at all — idle costs literally nothing
- Reduced-motion and high-contrast variants
- Captions off by default

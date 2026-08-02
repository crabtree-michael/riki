/**
 * Shared fakes for @riki/protocol, exported as `@riki/protocol/testing`.
 *
 * These are not test scaffolding: `pnpm dev:replay` drives the whole app through the same
 * fakes, which is what keeps them honest (REPO_SKELETON.md §5.2). No test may require a
 * running Dota 2 client, a real microphone, a GPU, or a live OpenAI session.
 *
 * `FakeVisionSidecar` lives here rather than in `apps/desktop` for the same reason `FakeGsiSource`
 * lives in `packages/gsi`: what it fakes is a *protocol peer*, and this package owns the protocol.
 * It plugs in as a `ChildProcessPort`, so everything the app does above that seam — supervision,
 * backoff, the codec, fusion — is the real thing.
 */

export {
  FAKE_IDENTITY,
  createFakeVisionSidecar,
  type FakeProcessHandle,
  type FakeProcessPort,
  type FakeSpawnRequest,
  type FakeVisionSidecar,
  type FakeVisionSidecarOptions,
  type FakeVisionStats,
  type VisionScript,
  type VisionStep,
} from './fake-sidecar.js';

export {
  defaultVisionScript,
  loadVisionFixture,
  parseVisionFixture,
  problemStep,
  sightings,
  type DefaultVisionScriptOptions,
  type Sighting,
  type SightingsOptions,
} from './vision-script.js';

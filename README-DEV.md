# Development notes

## Architecture

- `src/index.ts` exposes the MCP resources, tools, prompt, and server
  instructions.
- `src/juce-docs.ts` resolves documentation configuration, parses Doxygen
  HTML, searches class members, and provides guarded local-source access.
- `src/juce-docs.test.ts` contains deterministic JUCE 9-shaped parser and
  source-boundary regression tests.
- `src/test-client.ts` is a live MCP smoke client.

## Documentation parsing

The server reads Doxygen's `annotated.html` class index and
`class*.html` detail pages. JUCE namespace identifiers such as
`juce_1_1AudioProcessorGraph` are accepted for lookup and rendered as
`juce::AudioProcessorGraph`.

Parser changes must include a fixture-based test that represents the relevant
JUCE-generated HTML. The live smoke test is useful confirmation, but it must
not replace deterministic tests.

## Local source access

Source lookup requires a checkout containing `modules/`. Searches default
to that directory and can optionally cover the full checkout. Traversal skips
build metadata and symbolic links, accepts only source/header extensions, and
stops at the requested result count.

File reads:

- reject absolute paths, hidden segments, and `..`;
- resolve and verify the real path remains under the checkout;
- reject unsupported file types and files over 4 MiB;
- return no more than 400 lines.

## Configuration precedence

1. Environment variables.
2. Persisted JSON configuration.
3. Official JUCE master documentation.

The generated documentation path and JUCE source root are related but stored
separately. This allows hosted documentation to be paired with a local source
checkout.

## Verification

```bash
npm run check
npm run test:smoke
```

Before release, also configure a real local JUCE checkout and verify:

- `AudioProcessorGraph` class lookup;
- `addConnection` or `rebuild` member lookup;
- source search under `modules/juce_audio_processors`;
- bounded source retrieval from a returned match.

## Known scope

This server retrieves primary JUCE documentation and source context. It does
not infer real-time safety, guarantee that a public API is appropriate for an
audio callback, or replace application-specific tests.

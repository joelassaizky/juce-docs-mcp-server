# JUCE Docs MCP Server

An MCP server that gives Codex and other compatible clients version-matched
JUCE class documentation plus bounded access to a local JUCE source checkout.

This fork refreshes the original
[juce-docs-mcp-server](https://github.com/danielraffel/juce-docs-mcp-server)
for the current MCP SDK and JUCE 9 workflows.

## Capabilities

- Search JUCE classes by name.
- Read full Doxygen class documentation.
- Search methods and documented properties within a class.
- Search exact text in a configured local JUCE source tree.
- Read bounded line ranges from local JUCE C/C++/Objective-C source files.
- Switch between official master/develop docs, custom hosted docs, and
  generated documentation from a local JUCE checkout.

The local source tools are intentionally read-only. Paths are constrained to
the configured JUCE checkout, source-file types are allow-listed, reads are
limited to 4 MiB, and excerpts are capped at 400 lines.

## Requirements

- Node.js 20.18.1 or newer.
- Doxygen and Python only when generating local documentation.

## Build and test

```bash
npm install
npm run check
npm run test:smoke
```

`npm run check` compiles the TypeScript, runs local regression tests, and
checks for high-severity dependency advisories. The smoke test also exercises
the configured live documentation source.

## Recommended Codex setup: exact local JUCE version

Generate the documentation once if `docs/doxygen/doc/annotated.html` is not
already present:

```bash
cd "/path/to/JUCE/docs/doxygen"
python3 build.py
```

Then register the STDIO server:

```bash
codex mcp add juce-docs \
  --env JUCE_DOCS_SOURCE=local-path \
  --env JUCE_DOCS_LOCAL_PATH="/path/to/JUCE/docs/doxygen/doc" \
  --env JUCE_SOURCE_LOCAL_PATH="/path/to/JUCE" \
  -- node "/path/to/juce-docs-mcp-server/dist/index.js"
```

Codex stores MCP configuration in its shared `config.toml`. A newly
registered server becomes available to new client sessions; registering it
does not inject tools into a session that is already running.

## Documentation source options

The default source is the official JUCE master documentation.

| Source | Configuration |
|---|---|
| Stable hosted docs | `JUCE_DOCS_SOURCE=master` |
| Development hosted docs | `JUCE_DOCS_SOURCE=develop` |
| Custom hosted docs | `JUCE_DOCS_SOURCE=custom-url` and `JUCE_DOCS_BASE_URL` |
| Local generated docs | `JUCE_DOCS_SOURCE=local-path` and `JUCE_DOCS_LOCAL_PATH` |
| Local source checkout | `JUCE_SOURCE_LOCAL_PATH=/path/to/JUCE` |

Runtime choices are persisted in
`~/.juce-docs-mcp-server/config.json` unless environment variables override
them. `JUCE_DOCS_CONFIG_PATH` selects a different config file.

## MCP tools

| Tool | Purpose |
|---|---|
| `search-juce-classes` | Search class names |
| `get-juce-class-docs` | Retrieve one class and its documented members |
| `search-juce-class-members` | Search methods/properties within one class |
| `search-juce-source` | Search local JUCE source text |
| `get-juce-source-file` | Read a bounded local source excerpt |
| `get-juce-docs-config` | Inspect the resolved documentation/source setup |
| `set-juce-docs-source` | Switch the documentation source |
| `setup-local-juce-docs` | Locate or generate docs for a local JUCE checkout |

The server also exposes `juce://classes` and
`juce://class/{className}` resources.

## Development

```bash
npm run dev
```

See [README-DEV.md](./README-DEV.md) for parser and test details.

## License

MIT. See [LICENSE](./LICENSE).

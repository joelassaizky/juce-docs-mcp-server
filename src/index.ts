import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  fetchClassDocumentation,
  fetchClassList,
  searchClasses,
  searchClassMembers,
  searchJuceSource,
  readJuceSourceFile,
  formatClassDocumentation,
  formatMemberSearchResults,
  formatSourceSearchResults,
  formatSourceExcerpt,
  decodeClassIdentifier,
  getDocsConfigPath,
  getDocsSourceConfig,
  setDocsSourceConfig,
  setupLocalDocsFromJucePath
} from "./juce-docs.js";

// Create an MCP server
const server = new McpServer({
  name: "JUCE Documentation Server",
  version: "1.1.0"
}, {
  instructions:
    "Use class documentation for public API semantics and local source lookup for implementation details. " +
    "Prefer the configured local JUCE checkout so answers match the project's exact JUCE version. " +
    "Search source before inferring thread, graph, plug-in-hosting, or CoreAudio behavior."
});

function formatDocsConfigMarkdown(config: Awaited<ReturnType<typeof getDocsSourceConfig>>): string {
  const lines: string[] = ["# JUCE Docs Source Configuration", ""];
  lines.push(`- Source: \`${config.source}\``);
  lines.push(`- Resolved From: \`${config.resolvedFrom}\``);
  lines.push(`- Config Path: \`${config.configPath}\``);

  if (config.source === "local-path") {
    lines.push(`- Local Docs Path: \`${config.localDocsPath}\``);
    lines.push("");
    lines.push("Using local docs: all lookups stay on this machine.");
  } else {
    lines.push(`- Base URL: \`${config.baseUrl}\``);
    lines.push("");
    lines.push("Tip: local docs are usually faster. Use `setup-local-juce-docs` with your JUCE path.");
  }

  lines.push(`- Local JUCE Source: \`${config.localJucePath ?? "not configured"}\``);

  lines.push("");
  lines.push("Quick switches:");
  lines.push("- `set-juce-docs-source` with `source=master`");
  lines.push("- `set-juce-docs-source` with `source=develop`");
  lines.push("- `set-juce-docs-source` with `source=custom-url` + `url`");
  lines.push("- `setup-local-juce-docs` with `jucePath`");

  return lines.join("\n");
}

// Resource for getting documentation for a specific class
server.resource(
  "class-docs",
  new ResourceTemplate("juce://class/{className}", { list: undefined }),
  async (uri, { className }) => {
    console.error(`Fetching documentation for class: ${className}`);
    
    // Ensure className is a string
    const classNameStr = Array.isArray(className) ? className[0] : className;
    const doc = await fetchClassDocumentation(classNameStr);
    
    if (!doc) {
      return {
        contents: [{
          uri: uri.href,
          text: `Documentation for class '${classNameStr}' not found.`
        }]
      };
    }
    
    const markdown = formatClassDocumentation(doc);
    
    return {
      contents: [{
        uri: uri.href,
        text: markdown
      }]
    };
  }
);

// Resource for listing all available classes
server.resource(
  "class-list",
  "juce://classes",
  async (uri) => {
    console.error("Fetching list of all JUCE classes");
    
    const classes = await fetchClassList();
    
    return {
      contents: [{
        uri: uri.href,
        text: `# JUCE Classes\n\n${classes
          .map((classId) => `- [${decodeClassIdentifier(classId)}](juce://class/${classId})`)
          .join("\n")}`
      }]
    };
  }
);

// Tool for searching classes
server.tool(
  "search-juce-classes",
  // description added (Mandatory for Visual Studio support)
  "Searches for JUCE classes based on a query string. Use this to find specific components or classes in the JUCE framework.",
  { query: z.string(), },
  async ({ query }) => {
    console.error(`Searching for classes matching: ${query}`);
    
    const results = await searchClasses(query);
    
    if (results.length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: `No classes found matching '${query}'.` 
        }]
      };
    }
    
    const markdown = `# Search Results for '${query}'\n\n${results
      .map((classId) => `- [${decodeClassIdentifier(classId)}](juce://class/${classId})`)
      .join("\n")}`;
    
    return {
      content: [{ type: "text", text: markdown }]
    };
  }
);

// Tool for getting class documentation
server.tool(
  "get-juce-class-docs",
    // description added (Mandatory for Visual Studio support)
  "Retrieves detailed documentation and member functions for a specific JUCE class name.",
  { className: z.string() },
  async ({ className }) => {
    console.error(`Fetching documentation for class: ${className}`);
    
    const doc = await fetchClassDocumentation(className);
    
    if (!doc) {
      return {
        content: [{ 
          type: "text", 
          text: `Documentation for class '${className}' not found.` 
        }]
      };
    }
    
    const markdown = formatClassDocumentation(doc);
    
    return {
      content: [{ type: "text", text: markdown }]
    };
  }
);

server.tool(
  "search-juce-class-members",
  "Search methods and documented properties within one JUCE class.",
  {
    className: z.string(),
    query: z.string()
  },
  async ({ className, query }) => {
    const results = await searchClassMembers(className, query);
    return {
      content: [{
        type: "text",
        text: formatMemberSearchResults(className, query, results)
      }]
    };
  }
);

server.tool(
  "search-juce-source",
  "Search the configured local JUCE checkout for exact source text. Defaults to modules only.",
  {
    query: z.string(),
    caseSensitive: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
    scope: z.enum(["modules", "all"]).optional()
  },
  async ({ query, caseSensitive, maxResults, scope }) => {
    try {
      const results = await searchJuceSource(query, {
        caseSensitive,
        maxResults,
        scope
      });
      return {
        content: [{ type: "text", text: formatSourceSearchResults(query, results) }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `JUCE source search failed: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get-juce-source-file",
  "Read a bounded line range from a C/C++/Objective-C file in the configured local JUCE checkout.",
  {
    path: z.string(),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional()
  },
  async ({ path, startLine, endLine }) => {
    try {
      const excerpt = await readJuceSourceFile(path, startLine, endLine);
      return {
        content: [{ type: "text", text: formatSourceExcerpt(excerpt) }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `JUCE source read failed: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

server.tool(
  "get-juce-docs-config",
  "Shows the current docs source (master/develop/custom/local), where it came from, and how to switch quickly.",
  {},
  async () => {
    const config = await getDocsSourceConfig();
    return {
      content: [{ type: "text", text: formatDocsConfigMarkdown(config) }]
    };
  }
);

server.tool(
  "set-juce-docs-source",
  "Switch docs source to master, develop, custom URL, or local docs path. Persists to ~/.juce-docs-mcp-server/config.json (or JUCE_DOCS_CONFIG_PATH).",
  {
    source: z.enum(["master", "develop", "custom-url", "local-path"]),
    url: z.string().optional(),
    localDocsPath: z.string().optional(),
    localJucePath: z.string().optional()
  },
  async ({ source, url, localDocsPath, localJucePath }) => {
    try {
      const config = await setDocsSourceConfig({
        source,
        url,
        localDocsPath,
        localJucePath
      });
      return {
        content: [{ type: "text", text: formatDocsConfigMarkdown(config) }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text:
            `Failed to set docs source: ${error instanceof Error ? error.message : String(error)}\n\n` +
            `Config file: ${getDocsConfigPath()}`
        }]
      };
    }
  }
);

server.tool(
  "setup-local-juce-docs",
  "Configure docs from a local JUCE checkout path. Optionally generate docs if missing.",
  {
    jucePath: z.string(),
    generateIfMissing: z.boolean().optional()
  },
  async ({ jucePath, generateIfMissing }) => {
    try {
      const result = await setupLocalDocsFromJucePath(jucePath, generateIfMissing ?? false);
      const lines = [
        "# Local JUCE Docs Setup Complete",
        "",
        `- JUCE Path: \`${jucePath}\``,
        `- Local Docs Path: \`${result.docsPath}\``,
        `- Generated Docs This Run: \`${result.generatedDocs ? "yes" : "no"}\``,
        "",
        formatDocsConfigMarkdown(result.config)
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text:
            `Failed to configure local docs: ${error instanceof Error ? error.message : String(error)}\n\n` +
            "If docs are missing and you have a JUCE checkout, retry with `generateIfMissing=true`."
        }]
      };
    }
  }
);

// Prompt for exploring JUCE documentation
server.prompt(
  "explore-juce",
  { topic: z.string().optional() },
  ({ topic }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: topic 
          ? `Please help me understand the JUCE ${topic} functionality. What classes should I look at?` 
          : "Please help me explore the JUCE framework. What are the main components and classes I should know about?"
      }
    }]
  })
);

// Start the server
async function main() {
  try {
    console.error("Starting JUCE Documentation MCP Server...");
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    console.error("Server connected and ready to receive requests.");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main(); 

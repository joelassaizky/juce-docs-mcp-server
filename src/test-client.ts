import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  try {
    console.log("Starting test client for JUCE Documentation MCP Server...");
    
    // Create a transport that communicates with the server process
    const juceEnvironment = Object.fromEntries(
      [
        "JUCE_DOCS_SOURCE",
        "JUCE_DOCS_BASE_URL",
        "JUCE_DOCS_LOCAL_PATH",
        "JUCE_SOURCE_LOCAL_PATH",
        "JUCE_DOCS_CONFIG_PATH"
      ]
        .map((name) => [name, process.env[name]])
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
    );

    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: juceEnvironment
    });
    
    // Create an MCP client
    const client = new Client(
      {
        name: "JUCE Docs Test Client",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );
    
    // Connect to the server
    await client.connect(transport);
    console.log("Connected to server");
    
    // Test listing resources
    console.log("\nListing resources...");
    const resources = await client.listResources();
    console.log("Available resources:", resources);
    
    // Test listing tools
    console.log("\nListing tools...");
    const tools = await client.listTools();
    console.log("Available tools:", tools);
    
    // Test reading the class list resource
    console.log("\nReading class list...");
    const classList = await client.readResource({ uri: "juce://classes" });
    if (classList.contents[0] && "text" in classList.contents[0]) {
      const text = classList.contents[0].text;
      console.log("Class list:", text.substring(0, 200) + "...");
    }
    
    // Test reading a specific class resource
    console.log("\nReading ValueTree class documentation...");
    const valueTreeDocs = await client.readResource({ uri: "juce://class/ValueTree" });
    if (valueTreeDocs.contents[0] && "text" in valueTreeDocs.contents[0]) {
      const text = valueTreeDocs.contents[0].text;
      console.log("ValueTree docs:", text.substring(0, 200) + "...");
    }
    
    // Test searching for classes
    console.log("\nSearching for 'Audio' classes...");
    const searchResult = await client.callTool({
      name: "search-juce-classes",
      arguments: {
        query: "Audio"
      }
    });
    
    // Type assertion for content
    const content = searchResult.content as Array<{type: string, text: string}>;
    if (content && content.length > 0) {
      console.log("Search results:", content[0].text.substring(0, 200) + "...");
    }
    
    // Test getting class documentation
    console.log("\nGetting AudioBuffer class documentation...");
    const audioDocs = await client.callTool({
      name: "get-juce-class-docs",
      arguments: {
        className: "AudioBuffer"
      }
    });
    
    // Type assertion for content
    const audioContent = audioDocs.content as Array<{type: string, text: string}>;
    if (audioContent && audioContent.length > 0) {
      console.log("AudioBuffer docs:", audioContent[0].text.substring(0, 200) + "...");
    }

    console.log("\nSearching AudioProcessorGraph members for 'addNode'...");
    const memberSearch = await client.callTool({
      name: "search-juce-class-members",
      arguments: {
        className: "AudioProcessorGraph",
        query: "addNode"
      }
    });
    const memberContent = memberSearch.content as Array<{type: string, text: string}>;
    if (!memberContent[0]?.text.includes("addNode")) {
      throw new Error("AudioProcessorGraph member search did not return addNode.");
    }
    console.log("Member search:", memberContent[0].text.substring(0, 200) + "...");

    if (process.env.JUCE_SOURCE_LOCAL_PATH) {
      console.log("\nSearching the local JUCE source tree...");
      const sourceSearch = await client.callTool({
        name: "search-juce-source",
        arguments: {
          query: "UpdateKind::none",
          maxResults: 3
        }
      });
      const sourceContent = sourceSearch.content as Array<{type: string, text: string}>;
      if (!sourceContent[0]?.text.includes("UpdateKind::none")) {
        throw new Error("Local JUCE source search did not return UpdateKind::none.");
      }
      console.log("Source search:", sourceContent[0].text.substring(0, 240) + "...");
    }
    
    console.log("\nAll tests completed successfully!");
    
    // Clean up
    await client.close();
    process.exit(0);
  } catch (error) {
    console.error("Error in test client:", error);
    process.exit(1);
  }
}

main(); 

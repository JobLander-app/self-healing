import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "firebase-mcp-server",
  version: "2.0.0",
});

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("firebase-mcp-server v2.0.0 running via stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});

// client.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { HttpSseClientTransport } from '@modelcontextprotocol/sdk/client/http-sse.js';

// The URL your MCP server is listening on
const MCP_SERVER_URL = 'http://localhost:8080/mcp';

async function main() {
  console.log('--- Starting Playwright MCP Client ---');

  // 1. Create a transport
  const transport = new HttpSseClientTransport({
    url: MCP_SERVER_URL,
  });

  // 2. Create a new client instance
  const client = new Client({ name: 'OmiHackathonClient', version: '1.0.0' });

  try {
    // 3. Connect to the server
    console.log('Connecting to server...');
    await client.connect(transport);
    console.log('Connection successful!');

    // 4. Send the 'navigate' command
    console.log('Sending navigate command...');
    const response = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://www.uber.com/us/en/ride/' },
    });

    console.log('\n--- SERVER RESPONSE ---');
    console.log(response.content[0].text);
    console.log('-----------------------');

  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // 5. Close the client and the browser session
    console.log('\nClosing client...');
    await client.close();
    console.log('Client closed.');
  }
}

main();
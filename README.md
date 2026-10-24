# AI Studio MCP Bridge

Use MCP servers from Google AI Studio. Every tool call waits for your approval.

## Setup

**1. Start the bridge (only needed for local stdio servers).** Requires Node 18+.

```
cd bridge
cp servers.example.json servers.json   # edit the commands/paths
node bridge.js
```

**2. Load the extension.** Open `chrome://extensions`, turn on Developer mode, choose
Load unpacked, and select the `extension` folder.

**3. Add your servers.** Click the extension's toolbar icon.

- Local server named `files` in `servers.json`: `http://127.0.0.1:3939/mcp/files`
- Remote server: its URL, plus optional `headers` such as an API token

Save (Chrome asks for access to remote addresses), then press Test.

**4. Use it in AI Studio.** Open a chat and click the **MCP** pill at the bottom right.
It inserts the tool list and calling instructions into the message box. Add your task
and run. For a whole chat, paste the same text into System instructions instead.

## What happens on a tool call

1. Gemini ends its reply with an `mcp-call` block and stops.
2. An overlay shows the tool and its arguments (editable). Nothing runs yet.
3. **Approve** runs it once. **Always allow this tool** skips the prompt for that tool
   from now on (manage the list in settings). **Deny** tells Gemini not to retry.
4. The result is posted as your next message and Gemini continues.

## Limits to know about

- Calling is prompt-based, not AI Studio's built-in function calling, so the model
  has to follow the format. Gemini does not freeze mid-reply: it finishes its turn with
  the call and nothing continues until you approve.
- Remote servers must support Streamable HTTP. Servers that need OAuth or only offer the
  old `/sse` transport can be run through the bridge with `npx mcp-remote <url>` as the command.
- Tool results go to Google as part of your chat. Only allow-list tools that are safe to read from.
- The bridge only accepts requests from the extension; it does not listen beyond `127.0.0.1`.

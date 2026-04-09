function parseEventBlock(block) {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function* parseSseStream(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      buffer += chunk;
    } else {
      buffer += decoder.decode(chunk, { stream: true });
    }

    while (true) {
      const separatorMatch = buffer.match(/\r?\n\r?\n/);
      if (!separatorMatch) break;

      const separatorIndex = separatorMatch.index;
      const separatorLength = separatorMatch[0].length;
      const rawBlock = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separatorLength);
      const event = parseEventBlock(rawBlock);
      if (event) yield event;
    }
  }

  if (buffer.trim()) {
    const event = parseEventBlock(buffer);
    if (event) yield event;
  }
}

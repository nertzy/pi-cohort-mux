export function createJsonlFrameBuffer(onFrame) {
  let buffer = "";

  return {
    get buffer() {
      return buffer;
    },
    feed(chunk) {
      buffer += chunk;
      for (
        let newline = buffer.indexOf("\n");
        newline >= 0;
        newline = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) onFrame(JSON.parse(line));
      }
    },
  };
}

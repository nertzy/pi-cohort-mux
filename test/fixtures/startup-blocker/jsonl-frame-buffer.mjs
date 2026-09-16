export function createJsonlFrameBuffer(onFrame) {
  let buffer = "";

  return {
    get buffer() {
      return buffer;
    },
    feed(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) onFrame(JSON.parse(line));
      }
    },
  };
}

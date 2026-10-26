export default function createFakeExecutionBackend() {
  return {
    name: "fakemux",
    protocolVersion: 1,
    detect: async () => ({ available: true }),
    launch: async () => {
      throw new Error("not launched in this test");
    },
    reattach: async () => ({ status: "gone" }),
    close: async () => {},
  };
}

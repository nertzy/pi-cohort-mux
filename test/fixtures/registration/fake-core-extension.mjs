import { listBackends } from "./public-api-a.mjs";

export default function (pi) {
  pi.registerCommand("registration-spike", {
    description: "List registration spike backends",
    handler() {
      const names = listBackends().map((backend) => backend.name);
      console.error(`REGISTRATION_SPIKE_BACKENDS:${JSON.stringify(names)}`);
      return names;
    },
  });
}

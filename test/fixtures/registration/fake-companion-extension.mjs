import { registerBackend } from "./public-api-b.mjs";

export default function () {
  registerBackend({ name: "fake-backend" });
}

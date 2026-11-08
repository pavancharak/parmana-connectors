import { loadSignalConfig } from "./config.js";
import { createSignalHttpServer } from "./service.js";

/** Starts the Razorpay signal service. Configuration is read from the environment and checked first. */
const config = loadSignalConfig(process.env);
const server = createSignalHttpServer(config);
const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(
    `razorpay signal service listening on ${port} for ${config.audience}`,
  );
});

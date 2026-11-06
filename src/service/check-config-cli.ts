import { checkConfig } from "./check-config.js";

const result = checkConfig(process.env);
if (result.ok) {
  console.log("Configuration OK. The service would start with:");
  console.log(result.summary);
} else {
  console.error(`Configuration refused: ${result.reason}`);
  process.exitCode = 1;
}

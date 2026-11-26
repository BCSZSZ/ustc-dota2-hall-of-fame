import { readFileSync } from "node:fs";

const template = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
template.Resources.RegistrationFunction.Properties.Code.ZipFile =
  readFileSync(new URL("./handler.cjs", import.meta.url), "utf8");
process.stdout.write(JSON.stringify(template));

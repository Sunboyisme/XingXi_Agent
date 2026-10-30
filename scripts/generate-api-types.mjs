import { readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import ts from "typescript";

const schema = JSON.parse(
  await readFile(new URL("../.local-data/openapi.json", import.meta.url), "utf8"),
);
const declarations = await openapiTS(schema);
// Requests use api()/fetchApi(); only the shared payload schemas are consumed.
const components = declarations.find(
  (node) => ts.isInterfaceDeclaration(node) && node.name.text === "components",
);
if (!components) throw new Error("OpenAPI component schemas are missing.");

await writeFile(
  new URL("../src/lib/api.generated.ts", import.meta.url),
  COMMENT_HEADER + astToString([components]),
);
console.log("OpenAPI component types generated");

import { build } from "esbuild";

await build({
  entryPoints: ["test/suite/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist-test/suite.cjs",
  external: ["vscode"],
  logLevel: "warning",
});

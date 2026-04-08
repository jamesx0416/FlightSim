const DOC_URLS = [
  "https://docs.flightsimulator.com/html/Introduction/Using_The_SDK.htm",
  "https://docs.flightsimulator.com/html/Introduction/Introduction.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/Models.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/Model_Definitions.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/Model_Animation_Definitions.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/ModelBehaviors/Model_Behaviors.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/ModelBehaviors/General_Template_Definitions.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/ModelBehaviors/Input_Event_Definitions.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/ModelBehaviors/TemplateExplorer/Template_Explorer.html",
  "https://docs.flightsimulator.com/html/mergedProjects/How_To_Make_An_Aircraft/Contents/Model_Behaviours/Default_Templates.htm",
  "https://docs.flightsimulator.com/html/Asset_Creation/3D_Models/General_Principles.htm",
  "https://docs.flightsimulator.com/html/Asset_Creation/Blender_Plugin/The_Blender_Plugin.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/SimObjects/SimObjects.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/SimObjects/Aircraft_SimO/flight_model/interactive_points.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/VisualEffects/Visual_Effects_Landing_Templates.htm",
  "https://docs.flightsimulator.com/html/Content_Configuration/Checklists/Checklists.htm",
  "https://docs.flightsimulator.com/msfs2024/html/3_Models_And_Textures/Plugins/glTF_Schemas.htm",
  "https://docs.flightsimulator.com/msfs2024/flighting/html/3_Models_And_Textures/Textures/Materials/FlightSim_Materials.htm",
  "https://docs.flightsimulator.com/msfs2024/html/3_Models_And_Textures/Textures/Materials/FlightSim_Material_Parameters.htm",
  "https://docs.flightsimulator.com/msfs2024/flighting/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm",
  "https://docs.flightsimulator.com/html/mergedProjects/How_To_Make_An_Aircraft/Contents/Modelling/Airframe/Texturing/Surface_Detail.htm?agt=index"
];

const args = process.argv.slice(2);

function readOption(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));

  if (direct) {
    return direct.slice(prefix.length);
  }

  const index = args.indexOf(`--${name}`);
  if (index >= 0) {
    return args[index + 1] ?? fallback;
  }

  return fallback;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function outputPathForUrl(rootDir, url) {
  const parsed = new URL(url);
  const querySuffix = parsed.search ? `__${parsed.search.slice(1).replace(/[^a-z0-9]+/giu, "_")}` : "";
  const pathname = parsed.pathname.replace(/\/$/u, "/index");
  const dotIndex = pathname.lastIndexOf(".");
  const withQuerySuffix =
    dotIndex >= 0
      ? `${pathname.slice(0, dotIndex)}${querySuffix}${pathname.slice(dotIndex)}`
      : `${pathname}${querySuffix}.html`;

  return `${rootDir.replace(/\/$/, "")}${withQuerySuffix}`;
}

async function ensureDir(path) {
  await Bun.$`mkdir -p ${path}`.quiet();
}

async function main() {
  const outDir = readOption("out", "vendor/msfs-doc-references");
  const dryRun = hasFlag("dry-run");
  const matchText = readOption("match", "").toLowerCase();

  const selectedUrls = DOC_URLS.filter((url) =>
    !matchText || url.toLowerCase().includes(matchText)
  );

  console.log(`Found ${selectedUrls.length} reference doc page(s).`);

  const manifest = [];
  for (const url of selectedUrls) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const outputPath = outputPathForUrl(outDir, url);
    const directory = outputPath.slice(0, outputPath.lastIndexOf("/"));

    console.log(`${url} -> ${outputPath}`);

    manifest.push({
      url,
      path: outputPath.replace(/^vendor\//u, "")
    });

    if (dryRun) {
      continue;
    }

    await ensureDir(directory);
    await Bun.write(outputPath, html);
  }

  if (!dryRun) {
    await Bun.write(
      `${outDir.replace(/\/$/, "")}/manifest.json`,
      `${JSON.stringify({ docs: manifest }, null, 2)}\n`
    );
    console.log(`Wrote ${selectedUrls.length} reference doc page(s) to ${outDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

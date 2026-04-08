const TEMPLATE_INDEX_URL =
  "https://docs.flightsimulator.com/html/Content_Configuration/Models/ModelBehaviors/TemplateExplorer/Template_Explorer.html";

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

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }

    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }

    return named[entity] ?? `&${entity};`;
  });
}

function parseIndexEntries(html) {
  const entries = [];
  const linkPattern = /<a href="([^"]+\.html)">([^<]+\.xml)<\/a>/g;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const [, href, xmlPath] = match;

    entries.push({
      href,
      xmlPath,
    });
  }

  return entries;
}

function extractSourceXml(html) {
  const match = html.match(
    /<div class="collapsible">Source XML<\/div>\s*<div class="xmlSource collapsibleContent">([\s\S]*?)<\/div>/,
  );

  if (!match) {
    throw new Error("Could not find Source XML block");
  }

  return decodeHtmlEntities(match[1])
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimStart();
}

function normalizeXmlOutputPath(rootDir, xmlPath) {
  const relativePath = xmlPath.replaceAll("\\", "/");

  return `${rootDir.replace(/\/$/, "")}/${relativePath}`;
}

async function ensureDir(path) {
  await Bun.$`mkdir -p ${path}`.quiet();
}

async function main() {
  const outDir = readOption("out", "public/vendor/msfs-stock/ModelBehaviorDefs/Asobo");
  const matchText = readOption("match", "");
  const limitValue = readOption("limit");
  const limit = limitValue ? Number.parseInt(limitValue, 10) : Number.POSITIVE_INFINITY;
  const dryRun = hasFlag("dry-run");

  const indexResponse = await fetch(TEMPLATE_INDEX_URL);

  if (!indexResponse.ok) {
    throw new Error(`Failed to load template index: ${indexResponse.status} ${indexResponse.statusText}`);
  }

  const indexHtml = await indexResponse.text();
  let entries = parseIndexEntries(indexHtml);

  if (matchText) {
    const lowered = matchText.toLowerCase();
    entries = entries.filter((entry) => entry.xmlPath.toLowerCase().includes(lowered));
  }

  entries = entries.slice(0, limit);

  if (entries.length === 0) {
    console.log("No XML pages matched.");
    return;
  }

  console.log(`Found ${entries.length} XML page(s).`);

  let written = 0;
  const writtenPaths = [];

  for (const entry of entries) {
    const pageUrl = new URL(entry.href, TEMPLATE_INDEX_URL).toString();
    const outputPath = normalizeXmlOutputPath(outDir, entry.xmlPath);

    console.log(`${entry.xmlPath} <- ${pageUrl}`);

    if (dryRun) {
      continue;
    }

    const response = await fetch(pageUrl);

    if (!response.ok) {
      throw new Error(`Failed to load ${pageUrl}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const xml = extractSourceXml(html);
    const directory = outputPath.slice(0, outputPath.lastIndexOf("/"));

    await ensureDir(directory);
    await Bun.write(outputPath, `${xml}\n`);
    writtenPaths.push(outputPath);
    written += 1;
  }

  if (!dryRun) {
    const rootLayoutPath = `${outDir.replace(/\/ModelBehaviorDefs\/Asobo\/?$/u, "")}/layout.json`;
    const content = writtenPaths
      .map((path) => {
        const relativePath = path
          .replace(/^public\//u, "")
          .replace(`${outDir.replace(/^public\//u, "").replace(/\/$/, "")}/`, "ModelBehaviorDefs/Asobo/");

        return { path: relativePath.replaceAll("\\", "/") };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    const layoutDirectory = rootLayoutPath.slice(0, rootLayoutPath.lastIndexOf("/"));
    await ensureDir(layoutDirectory);
    await Bun.write(
      rootLayoutPath,
      `${JSON.stringify({ content }, null, 2)}\n`,
    );

    console.log(`Wrote ${written} XML file(s) to ${outDir}`);
    console.log(`Wrote behavior-root layout to ${rootLayoutPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

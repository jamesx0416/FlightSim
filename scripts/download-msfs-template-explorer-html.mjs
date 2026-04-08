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

function parseIndexEntries(html) {
  const entries = [];
  const linkPattern = /<a href="([^"]+\.html)">([^<]+)<\/a>/g;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    const [, href, label] = match;
    entries.push({ href, label });
  }

  return entries;
}

async function ensureDir(path) {
  await Bun.$`mkdir -p ${path}`.quiet();
}

async function main() {
  const outDir = readOption("out", "vendor/msfs-template-explorer-html");
  const dryRun = hasFlag("dry-run");
  const matchText = readOption("match", "").toLowerCase();

  const indexResponse = await fetch(TEMPLATE_INDEX_URL);
  if (!indexResponse.ok) {
    throw new Error(`Failed to load template index: ${indexResponse.status} ${indexResponse.statusText}`);
  }

  const indexHtml = await indexResponse.text();
  const entries = parseIndexEntries(indexHtml).filter((entry) =>
    !matchText ||
    entry.href.toLowerCase().includes(matchText) ||
    entry.label.toLowerCase().includes(matchText)
  );

  console.log(`Found ${entries.length} template explorer page(s).`);

  const manifest = [];
  for (const entry of entries) {
    const pageUrl = new URL(entry.href, TEMPLATE_INDEX_URL).toString();
    const outputPath = `${outDir.replace(/\/$/, "")}/${entry.href.replace(/^\/+/u, "")}`;
    const directory = outputPath.slice(0, outputPath.lastIndexOf("/"));

    console.log(`${pageUrl} -> ${outputPath}`);
    manifest.push({
      url: pageUrl,
      path: outputPath.replace(/^vendor\//u, ""),
      label: entry.label
    });

    if (dryRun) {
      continue;
    }

    const response = await fetch(pageUrl);
    if (!response.ok) {
      throw new Error(`Failed to load ${pageUrl}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    await ensureDir(directory);
    await Bun.write(outputPath, html);
  }

  if (!dryRun) {
    await ensureDir(outDir);
    await Bun.write(
      `${outDir.replace(/\/$/, "")}/manifest.json`,
      `${JSON.stringify({ docs: manifest }, null, 2)}\n`
    );
    console.log(`Wrote ${entries.length} template explorer page(s) to ${outDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

const CFG_INDEX_URL =
  "https://docs.flightsimulator.com/html/Additional_Information/File_Formats/CFG_Files.htm";

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

function collectLinks(html, pageUrl) {
  const links = [];
  const linkPattern = /<a href="([^"]+)">/g;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    try {
      links.push(new URL(match[1], pageUrl).toString());
    } catch {
      // Ignore invalid URLs in docs HTML.
    }
  }

  return links;
}

function isSameDocsSite(url) {
  const parsed = new URL(url);

  return (
    parsed.origin === "https://docs.flightsimulator.com" &&
    parsed.pathname.startsWith("/html/")
  );
}

function isCfgReferencePage(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;

  if (path.endsWith("/CFG_Files.htm")) {
    return true;
  }

  return (
    /(?:^|\/)[^/]*_cfg\.htm$/i.test(path) ||
    path.endsWith("/Aircraft.htm") ||
    path.endsWith("/Living_Things_sim_cfg.htm")
  );
}

function outputPathForUrl(rootDir, url) {
  const parsed = new URL(url);

  return `${rootDir.replace(/\/$/, "")}${parsed.pathname}`;
}

async function ensureDir(path) {
  await Bun.$`mkdir -p ${path}`.quiet();
}

async function main() {
  const outDir = readOption("out", "vendor/msfs-doc-cfgs");
  const dryRun = hasFlag("dry-run");
  const matchText = readOption("match", "").toLowerCase();

  const queue = [CFG_INDEX_URL];
  const visited = new Set();
  const downloads = [];

  while (queue.length > 0) {
    const currentUrl = queue.shift();

    if (!currentUrl || visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    const response = await fetch(currentUrl);

    if (!response.ok) {
      throw new Error(`Failed to load ${currentUrl}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    if (isCfgReferencePage(currentUrl)) {
      if (!matchText || currentUrl.toLowerCase().includes(matchText)) {
        downloads.push({ url: currentUrl, html });
      }
    }

    for (const link of collectLinks(html, currentUrl)) {
      const clean = link.split("#")[0];

      if (!isSameDocsSite(clean) || visited.has(clean) || queue.includes(clean)) {
        continue;
      }

      if (isCfgReferencePage(clean)) {
        queue.push(clean);
      }
    }
  }

  console.log(`Found ${downloads.length} CFG doc page(s).`);

  for (const item of downloads) {
    const outputPath = outputPathForUrl(outDir, item.url);
    const directory = outputPath.slice(0, outputPath.lastIndexOf("/"));

    console.log(`${item.url} -> ${outputPath}`);

    if (dryRun) {
      continue;
    }

    await ensureDir(directory);
    await Bun.write(outputPath, item.html);
  }

  if (!dryRun) {
    console.log(`Wrote ${downloads.length} CFG doc page(s) to ${outDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

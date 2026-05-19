#!/usr/bin/env bun

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  const index = args.indexOf(`--${name}`);
  return inline?.slice(name.length + 3) ?? (index >= 0 ? args[index + 1] : fallback);
};

const maxAge = durationToSeconds(option("max-age", "10m"));
const dryRun = flag("dry-run");
const force = flag("force");
const killAll = flag("kill-all");
const once = flag("once") || killAll;
const processTypes = [
  {
    label: "agent-browser",
    pattern: /\/agent-browser(?:-[^/\s]+)?(?:\s|$)/,
  },
  {
    label: "chrome-devtools-mcp",
    pattern: /\/chrome-devtools-mcp(?:-[^/\s]+)?\/.*\/index\.js(?:\s|$)/,
  },
];

while (true) {
  const waitSeconds = await sweep();

  if (once) {
    break;
  }

  console.log(`Sleeping ${formatSeconds(waitSeconds)}.`);
  await Bun.sleep(waitSeconds * 1000);
}

async function sweep() {
  const processes = await readProcesses();
  const childrenByParent = Map.groupBy(processes, (process) => process.ppid);
  const roots = processes.flatMap((process) => {
    const type = processTypes.find((type) => type.pattern.test(process.command));
    return type ? [{ ...process, label: type.label }] : [];
  });
  const targets = killAll ? roots : roots.filter((process) => process.age > maxAge);

  if (targets.length === 0) {
    console.log(
      killAll
        ? "No agent-browser or chrome-devtools-mcp instances found."
        : `No agent-browser or chrome-devtools-mcp instances older than ${formatSeconds(maxAge)}.`,
    );
  }

  for (const target of targets) {
    const descendants = descendantsOf(target.pid, childrenByParent);
    const processGroup = [...descendants, target];

    console.log(
      `${dryRun ? "Would kill" : "Killing"} ${target.label} PID ${target.pid} ` +
        `(${formatSeconds(target.age)} old) and ${descendants.length} child process(es).`,
    );

    if (dryRun) {
      for (const process of processGroup) {
        console.log(`  ${process.pid} ${process.command}`);
      }
      continue;
    }

    for (const process of processGroup) {
      kill(process.pid, "SIGTERM");
    }

    if (force) {
      await Bun.sleep(1000);
      for (const process of processGroup) {
        kill(process.pid, "SIGKILL");
      }
    }
  }

  const freshRoots = roots.filter((process) => !targets.includes(process));
  return freshRoots.length === 0 ? maxAge : Math.max(1, maxAge - Math.max(...freshRoots.map((process) => process.age)));
}

async function readProcesses() {
  const proc = Bun.spawn(["ps", "-axo", "pid,ppid,etime,command"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`ps failed: ${stderr.trim()}`);
  }

  return stdout
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), age: etimeToSeconds(match[3]), command: match[4] }]
        : [];
    });
}

function descendantsOf(pid, childrenByParent) {
  const descendants = [];
  const queue = [...(childrenByParent.get(pid) ?? [])];

  for (const process of queue) {
    descendants.push(process);
    queue.push(...(childrenByParent.get(process.pid) ?? []));
  }

  return descendants;
}

function durationToSeconds(value) {
  const match = /^(\d+)([smh])?$/.exec(value);

  if (!match) {
    throw new Error(`Invalid duration "${value}". Use seconds, or suffix with m/h.`);
  }

  return Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] ?? "s"]);
}

function etimeToSeconds(value) {
  const [dayOrTime, maybeTime] = value.split("-");
  const days = maybeTime ? Number(dayOrTime) : 0;
  const parts = (maybeTime ?? dayOrTime).split(":").map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts];
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function formatSeconds(value) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function kill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

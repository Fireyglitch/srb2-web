"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const SAVE_EXTENSIONS = new Set([".ssg", ".ss0", ".ss1", ".sav", ".rpl", ".lmp", ".dmo"]);
const SKIP_SAVE_SCAN = new Set(["addons", "models", "srb2-web", "node_modules", ".git"]);
const MAX_WRANGLER_UPLOAD_SIZE = 315 * 1024 * 1024;

function parseArguments(args) {
  const options = { prefix: "srb2-custom", preview: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--preview") {
      options.preview = true;
    } else if (["--root", "--bucket", "--public-base-url", "--prefix"].includes(arg)) {
      if (!args[i + 1]) {
        throw new Error(`Missing value for ${arg}.`);
      }
      const key = {
        "--root": "root",
        "--bucket": "bucket",
        "--public-base-url": "publicBaseUrl",
        "--prefix": "prefix",
      }[arg];
      options[key] = args[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.root) {
    throw new Error("Use --root <SRB2 folder>. Add --preview to inspect files without uploading.");
  }
  return options;
}

async function requireDirectory(directory, label) {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} was not found: ${directory}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
}

async function* walkFiles(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function addDirectoryAssets(entries, directory, type, keyPrefix) {
  for await (const source of walkFiles(directory)) {
    const relative = path.relative(directory, source).split(path.sep).join("/");
    const stat = await fs.stat(source);
    entries.push({ type, key: `${keyPrefix}/${relative}`, size: stat.size, source });
  }
}

function formatMiB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function getPublicBaseUrl(value, prefix) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Public base URL must be HTTPS and must not contain credentials, a query, or a fragment.");
  }
  return `${value.replace(/\/+$/, "")}/${prefix}`;
}

function validateCommandArgument(value) {
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error(`A path or key contains a character Wrangler cannot safely receive on Windows: ${value}`);
  }
}

function runWrangler(args) {
  let result;
  if (process.platform === "win32") {
    const command = `npx.cmd --yes wrangler@latest ${args
      .map((arg) => {
        validateCommandArgument(arg);
        return `"${arg}"`;
      })
      .join(" ")}`;
    result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      stdio: "inherit",
      windowsHide: true,
    });
  } else {
    result = spawnSync("npx", ["--yes", "wrangler@latest", ...args], {
      stdio: "inherit",
    });
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler failed with exit code ${result.status}.`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(options.root);
  const addonsRoot = path.join(root, "addons");
  const modelsRoot = path.join(root, "models");
  const modelsIndex = path.join(root, "models.dat");

  await requireDirectory(addonsRoot, "Add-ons folder");
  await requireDirectory(modelsRoot, "Models folder");

  let modelIndexStat;
  try {
    modelIndexStat = await fs.stat(modelsIndex);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`models.dat was not found: ${modelsIndex}`);
    }
    throw error;
  }
  if (!modelIndexStat.isFile()) {
    throw new Error(`models.dat is not a file: ${modelsIndex}`);
  }

  const entries = [];
  await addDirectoryAssets(entries, addonsRoot, "addon", "addons");
  await addDirectoryAssets(entries, modelsRoot, "model", "models");
  entries.push({ type: "model-index", key: "models.dat", size: modelIndexStat.size, source: modelsIndex });

  const rootEntries = await fs.readdir(root, { withFileTypes: true });
  const saveCandidates = [];
  for (const entry of rootEntries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile()) {
      saveCandidates.push(fullPath);
    } else if (entry.isDirectory() && !SKIP_SAVE_SCAN.has(entry.name.toLowerCase())) {
      for await (const file of walkFiles(fullPath)) {
        saveCandidates.push(file);
      }
    }
  }

  for (const source of saveCandidates) {
    if (!SAVE_EXTENSIONS.has(path.extname(source).toLowerCase())) {
      continue;
    }
    const relative = path.relative(root, source).split(path.sep).join("/");
    const stat = await fs.stat(source);
    entries.push({ type: "save", key: `saves/${relative}`, size: stat.size, source });
  }

  if (entries.length === 0) {
    throw new Error(`No custom assets were found under ${root}.`);
  }

  const totals = new Map();
  for (const entry of entries) {
    const total = totals.get(entry.type) || { count: 0, bytes: 0 };
    total.count += 1;
    total.bytes += entry.size;
    totals.set(entry.type, total);
  }
  for (const [type, total] of totals) {
    console.log(`${type}: ${total.count} files, ${formatMiB(total.bytes)}`);
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`Total: ${entries.length} files, ${formatMiB(totalBytes)}`);

  if (options.preview) {
    return;
  }
  if (!options.bucket || !options.publicBaseUrl) {
    throw new Error("Supply --bucket and --public-base-url, or use --preview.");
  }
  if (
    options.prefix.startsWith("/") ||
    options.prefix.endsWith("/") ||
    options.prefix.includes("\\") ||
    options.prefix.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Prefix must be a relative path without empty or dot segments.");
  }
  if (entries.some((entry) => entry.size > MAX_WRANGLER_UPLOAD_SIZE)) {
    throw new Error("Wrangler's per-object upload limit is 315 MiB. Upload oversized files with an S3-compatible multipart tool.");
  }

  for (const value of [options.bucket, options.prefix, ...entries.flatMap((entry) => [entry.key, entry.source])]) {
    validateCommandArgument(value);
  }

  const baseUrl = getPublicBaseUrl(options.publicBaseUrl, options.prefix);
  const manifest = {
    version: 1,
    baseUrl,
    files: entries.map(({ type, key, size }) => ({ type, key, size })),
  };
  const manifestPath = path.join(os.tmpdir(), `srb2-custom-manifest-${randomUUID()}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  try {
    try {
      runWrangler(["whoami"]);
    } catch (error) {
      throw new Error(`Wrangler is not ready. Run "npx wrangler login" first. ${error.message}`);
    }

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      console.log(`Uploading ${i + 1}/${entries.length}: ${entry.key}`);
      runWrangler([
        "r2",
        "object",
        "put",
        `${options.bucket}/${options.prefix}/${entry.key}`,
        `--file=${entry.source}`,
      ]);
    }

    runWrangler([
      "r2",
      "object",
      "put",
      `${options.bucket}/${options.prefix}/manifest.json`,
      `--file=${manifestPath}`,
      "--content-type=application/json",
    ]);
    console.log(`Upload complete. Manifest URL: ${baseUrl}/manifest.json`);
  } finally {
    await fs.unlink(manifestPath);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

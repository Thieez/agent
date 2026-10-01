const { spawnSync } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { access, chmod, mkdir, mkdtemp, rm, symlink } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");

const agentRoot = path.resolve(__dirname, "..");
const releaseApiUrl = "https://api.github.com/repos/PowerShell/PowerShell/releases/latest";

function linuxAssetName(architecture) {
  const architectureName = {
    x64: "x64",
    arm64: "arm64"
  }[architecture];
  if (!architectureName) throw new Error(`PowerShell installation does not support Linux ${architecture}.`);
  return new RegExp(`^powershell-[0-9][^-]*-linux-${architectureName}\\.tar\\.gz$`, "i");
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function getReleaseAsset(fetchImplementation, architecture) {
  const releaseResponse = await fetchImplementation(releaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "gup-repo-agent"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!releaseResponse.ok) {
    throw new Error(`PowerShell release lookup failed with HTTP ${releaseResponse.status}.`);
  }
  const release = await releaseResponse.json();
  const assetPattern = linuxAssetName(architecture);
  const asset = release.assets?.find((entry) => assetPattern.test(entry.name));
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new Error(`No Linux ${architecture} archive was found in the latest stable PowerShell release.`);
  }
  return asset;
}

async function installPowerShell({
  platform = process.platform,
  architecture = process.arch,
  root = agentRoot,
  fetchImplementation = fetch
} = {}) {
  if (platform === "win32") {
    console.log("Using the built-in Windows PowerShell.");
    return;
  }
  if (platform !== "linux") {
    throw new Error(`PowerShell installation is not configured for ${platform}.`);
  }

  const targetRoot = path.join(root, "node_modules", "powershell");
  const targetExecutable = path.join(targetRoot, "pwsh");
  const targetLink = path.join(root, "node_modules", ".bin", "pwsh");
  if (await pathExists(targetExecutable)) {
    await chmod(targetExecutable, 0o755);
    if (!(await pathExists(targetLink))) {
      await symlink(path.relative(path.dirname(targetLink), targetExecutable), targetLink);
    }
    verifyPowerShell(targetExecutable);
    console.log("PowerShell is already installed.");
    return;
  }

  const asset = await getReleaseAsset(fetchImplementation, architecture);
  const downloadResponse = await fetchImplementation(asset.browser_download_url, {
    signal: AbortSignal.timeout(120000)
  });
  if (!downloadResponse.ok || !downloadResponse.body) {
    throw new Error(`PowerShell download failed with HTTP ${downloadResponse.status}.`);
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gup-powershell-"));
  try {
    const archivePath = path.join(temporaryRoot, asset.name);
    await pipeline(downloadResponse.body, createWriteStream(archivePath, { flags: "wx" }));
    await mkdir(targetRoot, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", targetRoot], {
      stdio: "inherit",
      windowsHide: true
    });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(`Extracting PowerShell failed with status ${extraction.status}.`);
    }
    await chmod(targetExecutable, 0o755);
    await mkdir(path.dirname(targetLink), { recursive: true });
    if (!(await pathExists(targetLink))) {
      await symlink(path.relative(path.dirname(targetLink), targetExecutable), targetLink);
    }
    verifyPowerShell(targetExecutable);
    console.log(`Installed PowerShell ${releaseVersion(asset.name)}.`);
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyPowerShell(executable, spawnImplementation = spawnSync) {
  const result = spawnImplementation(executable, [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()"
  ], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`The installed PowerShell could not start (status ${result.status}).`);
  }
  const version = result.stdout.trim();
  if (!version) throw new Error("The installed PowerShell did not report its version.");
  return version;
}

function releaseVersion(assetName) {
  const match = assetName.match(/^powershell-([0-9][^-]*)-linux-/i);
  return match ? match[1] : "latest";
}

if (require.main === module) {
  installPowerShell().catch((error) => {
    console.error(`Failed to install PowerShell: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { getReleaseAsset, installPowerShell, linuxAssetName, releaseVersion, verifyPowerShell };

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getReleaseAsset,
  installPowerShell,
  linuxAssetName,
  releaseVersion
} = require("./install-powershell");

test("selects the official stable PowerShell archive for the server architecture", async () => {
  const asset = await getReleaseAsset(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/PowerShell/PowerShell/releases/latest");
    assert.equal(options.headers.Accept, "application/vnd.github+json");
    return new Response(JSON.stringify({
      assets: [
        {
          name: "powershell-7.6.0-linux-arm64.tar.gz",
          browser_download_url: "https://example.test/arm64.tar.gz"
        },
        {
          name: "powershell-7.6.0-linux-x64.tar.gz",
          browser_download_url: "https://example.test/x64.tar.gz"
        }
      ]
    }), { status: 200 });
  }, "x64");

  assert.equal(asset.name, "powershell-7.6.0-linux-x64.tar.gz");
  assert.equal(releaseVersion(asset.name), "7.6.0");
  assert.equal(linuxAssetName("arm64").test("powershell-7.6.0-linux-arm64.tar.gz"), true);
});

test("fails clearly when the release archive is unavailable", async () => {
  await assert.rejects(
    getReleaseAsset(async () => new Response("{}", { status: 200 }), "x64"),
    /No Linux x64 archive/
  );
  assert.throws(() => linuxAssetName("unsupported"), /does not support Linux/);
});

test("uses the Windows PowerShell installation without downloading a Linux archive", async () => {
  await installPowerShell({
    platform: "win32",
    fetchImplementation: async () => {
      throw new Error("Windows should not download PowerShell.");
    }
  });
});

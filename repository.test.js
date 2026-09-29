const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRepository } = require("./repository");

test("accepts repository slugs and HTTPS GitHub URLs", () => {
  assert.equal(parseRepository("owner/repo"), "owner/repo");
  assert.equal(parseRepository(" https://github.com/Owner/Repo.git "), "Owner/Repo");
  assert.equal(parseRepository("https://github.com/owner/repo/"), "owner/repo");
});

test("rejects non-GitHub URLs, extra path segments, and unsafe names", () => {
  assert.equal(parseRepository("git@github.com:owner/repo.git"), null);
  assert.equal(parseRepository("https://evil.example/owner/repo"), null);
  assert.equal(parseRepository("https://github.com/owner/repo?tab=readme"), null);
  assert.equal(parseRepository("owner/repo/extra"), null);
  assert.equal(parseRepository("../repo"), null);
  assert.equal(parseRepository("owner/.."), null);
  assert.equal(parseRepository(4), null);
});

function parseRepository(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  const urlMatch = value.match(/^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (urlMatch) value = `${urlMatch[1]}/${urlMatch[2]}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return null;
  const [owner, name] = value.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

module.exports = { parseRepository };

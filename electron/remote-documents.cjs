function githubRawUrl(url) {
  if (url.hostname !== "github.com") return url.toString();
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || (parts[2] !== "blob" && parts[2] !== "raw")) return url.toString();
  const [owner, repository, , revision, ...file] = parts;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${revision}/${file.join("/")}`;
}

function remoteRequest(input) {
  if (typeof input !== "string") return null;
  try {
    const sourceUrl = new URL(input.trim());
    if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") return null;
    const parts = sourceUrl.pathname.split("/").filter(Boolean);
    const encodedName = parts[parts.length - 1] || "Remote.md";
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch { /* keep encoded filename */ }
    return { requestUrl: githubRawUrl(sourceUrl), name };
  } catch {
    return null;
  }
}

function createRemoteDocuments({ fetch }) {
  return {
    async open(input) {
      const request = remoteRequest(input);
      if (!request) return { status: "error", message: "Enter a valid http(s) URL." };

      let response;
      try {
        response = await fetch(request.requestUrl, { redirect: "follow" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { status: "error", message: `Couldn't reach that URL (${detail}).` };
      }
      if (!response.ok) {
        return { status: "error", message: `Couldn't open that URL (HTTP ${response.status}).` };
      }
      try {
        const content = await response.text();
        return {
          status: "opened",
          document: { url: request.requestUrl, name: request.name, content },
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { status: "error", message: `Couldn't read that document (${detail}).` };
      }
    },
  };
}

module.exports = { createRemoteDocuments };

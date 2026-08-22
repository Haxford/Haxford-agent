/**
 * haxford.dev install proxy
 *
 * Proxies all requests to the raw GitHub content of the Haxford-agent repo.
 * curl -fsSL https://haxford.dev/install.sh | bash
 */

const OWNER = "Haxford";
const REPO = "Haxford-agent";
const BRANCH = "main";
const UPSTREAM = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    // Root redirects to the GitHub repo
    if (path === "/" || path === "") {
      return Response.redirect(`https://github.com/${OWNER}/${REPO}`, 302);
    }

    // Proxy everything else to raw GitHub content
    const upstream = `${UPSTREAM}${path}`;
    const upstreamReq = new Request(upstream, request);
    const response = await fetch(upstreamReq);

    // Copy the response, adding a cache header for edge caching
    return new Response(response.body, response);
  },
};

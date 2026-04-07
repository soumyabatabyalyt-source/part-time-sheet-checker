// ============================================================
// Reddit Status Checker — Cloudflare Worker
// Deploy at: https://workers.cloudflare.com (free tier)
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // CORS headers — allow your frontend origin
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ── POST /check  { links: [...] }
    if (request.method === "POST" && url.pathname === "/check") {
      try {
        const body = await request.json();
        const links = body.links || [];

        const results = await Promise.all(
          links.map(async (link) => {
            try {
              const status = await checkRedditLink(link);
              return { link, status };
            } catch (e) {
              return { link, status: "error", error: e.message };
            }
          })
        );

        return new Response(JSON.stringify({ results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── GET /check?url=...  (single link)
    if (request.method === "GET" && url.pathname === "/check") {
      const link = url.searchParams.get("url");
      if (!link) {
        return new Response(JSON.stringify({ error: "Missing ?url=" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      try {
        const status = await checkRedditLink(link);
        return new Response(JSON.stringify({ link, status }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ link, status: "error", error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Health check
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, service: "Reddit Status Checker" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ── Core checker logic ──────────────────────────────────────

async function checkRedditLink(rawUrl) {
  const jsonUrl = toJsonUrl(rawUrl);

  const res = await fetch(jsonUrl, {
    headers: {
      // Pretend to be the Reddit mobile app — avoids bot blocks
      "User-Agent": "Mozilla/5.0 (compatible; RedditStatusChecker/1.0)",
      Accept: "application/json",
    },
    redirect: "follow",
  });

  if (res.status === 404) return "removed";
  if (res.status === 403) return "removed"; // banned subreddit / removed
  if (!res.ok) return "error";

  let data;
  try {
    data = await res.json();
  } catch {
    return "error";
  }

  const type = detectType(rawUrl);

  if (type === "comment") {
    return checkComment(data);
  } else {
    return checkPost(data);
  }
}

function checkPost(data) {
  try {
    const listing = Array.isArray(data) ? data[0] : data;
    const post = listing?.data?.children?.[0]?.data;
    if (!post) return "error";

    // Multiple removal signals Reddit uses
    if (
      post.removed_by_category ||
      post.selftext === "[removed]" ||
      post.selftext === "[deleted]" ||
      post.removed === true ||
      post.spam === true
    ) {
      return "removed";
    }

    return "live";
  } catch {
    return "error";
  }
}

function checkComment(data) {
  try {
    // Reddit comment JSON: [postListing, commentListing]
    if (!Array.isArray(data) || data.length < 2) {
      // Fallback: might be a post URL that happens to have /comments/ in it
      return checkPost(data);
    }

    const commentListing = data[1];
    const comment = commentListing?.data?.children?.[0]?.data;

    if (!comment) return "error";

    if (
      comment.body === "[removed]" ||
      comment.body === "[deleted]" ||
      comment.removed === true ||
      comment.spam === true
    ) {
      return "removed";
    }

    // Also check if parent post was removed
    const postListing = data[0];
    const post = postListing?.data?.children?.[0]?.data;
    if (post?.removed_by_category) return "removed";

    return "live";
  } catch {
    return "error";
  }
}

function detectType(url) {
  // Comment URLs have a comment ID segment after the post title
  // e.g. /comments/postId/title/commentId/
  const parts = url.replace(/\/$/, "").split("/");
  const commentsIdx = parts.indexOf("comments");
  if (commentsIdx !== -1 && parts.length > commentsIdx + 3) {
    return "comment";
  }
  return "post";
}

function toJsonUrl(url) {
  let u = url.trim().replace(/\/$/, "");
  // Strip query params and fragments for cleaner JSON fetch
  u = u.split("?")[0].split("#")[0];
  // Force reddit.com (not old.reddit or www)
  u = u.replace("old.reddit.com", "www.reddit.com").replace("//reddit.com", "//www.reddit.com");
  if (!u.endsWith(".json")) u += ".json";
  return u;
}

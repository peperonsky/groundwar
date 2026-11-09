// The Cloudflare Worker behind groundwar.app.
//
// The site itself is the static files in this repo, served by the assets
// binding (wrangler.jsonc); a request for any of them never reaches this
// code. The one thing handled here is POST /api/feedback: the "Send
// feedback" form, emailed to the site owner through Cloudflare Email
// Routing, so the owner's address never appears in the page or the repo.
// Setup is in the README, under "Feedback form".

const MAX_BODY = 20000; // bytes of JSON accepted
const MAX_MESSAGE = 3000; // characters
const KINDS = {
  missing: "Something's missing",
  wrong: "Something's wrong",
  idea: "Idea",
  other: "Other",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/feedback") return handleFeedback(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Trimmed text with Windows/Mac line endings normalised, cut to a length.
const text = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "");
// The same, on one line: for anything that ends up in a header (subject).
const line = (v, max) => text(v, max).replace(/\s+/g, " ");

async function handleFeedback(request, env, url) {
  if (request.method !== "POST") return reply({ ok: false, error: "method" }, 405);

  // Only the site's own pages may post here. A browser always sends Origin
  // on a POST, and a page elsewhere can't send JSON here at all without a
  // CORS preflight, which this never answers.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return reply({ ok: false, error: "origin" }, 403);
  if (!(request.headers.get("Content-Type") || "").includes("application/json")) {
    return reply({ ok: false, error: "type" }, 415);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply({ ok: false, error: "size" }, 413);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return reply({ ok: false, error: "json" }, 400);
  }
  if (!data || typeof data !== "object") return reply({ ok: false, error: "json" }, 400);

  // The form has a field people can't see; only bots fill it in. Tell them
  // it worked, so they don't try again any harder.
  if (data.website) return reply({ ok: true });

  // A few messages a minute from one address at most (per Cloudflare
  // location, so approximate), so nobody can flood the inbox.
  if (env.FEEDBACK_LIMIT) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.FEEDBACK_LIMIT.limit({ key: ip });
    if (!success) return reply({ ok: false, error: "rate" }, 429);
  }

  const message = text(data.message, MAX_MESSAGE);
  if (message.length < 5) return reply({ ok: false, error: "message" }, 400);
  const kind = Object.hasOwn(KINDS, data.kind) ? data.kind : "other";
  const email = line(data.email, 254);
  if (email && !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(email)) {
    return reply({ ok: false, error: "email" }, 400);
  }
  const page = line(data.page, 600);
  const place = line(data.place, 200);
  const item = line(data.item, 300);
  const itemId = /^Q\d+$/.test(data.itemId || "") ? data.itemId : "";

  if (!env.FEEDBACK_EMAIL || !env.FEEDBACK_TO) {
    console.error("Feedback isn't set up: the send_email binding or the FEEDBACK_TO secret is missing.");
    return reply({ ok: false, error: "unconfigured" }, 503);
  }

  const about = item || place;
  const subject = line(`Groundwar: ${KINDS[kind]}${about ? ` (${about})` : ""}`, 150);
  const details = [
    `Reply to: ${email || "(no email given)"}`,
    `Page: ${page || "(unknown)"}`,
  ];
  if (place) details.push(`Place: ${place}`);
  if (item) details.push(`Entry: ${item}${itemId ? ` (https://www.wikidata.org/wiki/${itemId})` : ""}`);
  details.push(`Browser: ${line(request.headers.get("User-Agent"), 300) || "(unknown)"}`);
  details.push(`Sent: ${new Date().toISOString()}`);
  const body = [KINDS[kind], "", message, "", "--", ...details].join("\n");

  try {
    await env.FEEDBACK_EMAIL.send({
      to: env.FEEDBACK_TO,
      from: { email: env.FEEDBACK_FROM || `feedback@${url.hostname}`, name: "Groundwar feedback" },
      ...(email ? { replyTo: email } : {}),
      subject,
      text: body,
    });
  } catch (err) {
    console.error("Feedback email failed:", err?.code, err?.message);
    return reply({ ok: false, error: "send" }, 502);
  }
  return reply({ ok: true });
}

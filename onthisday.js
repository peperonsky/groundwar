// "On this day": fills the page's <section data-on-this-day> (on the homepage
// and /places/) with today's entries from data/onthisday/<MM-DD>.json, using
// the visitor's own date. Those files are rebuilt weekly by
// scripts/build-place-pages.mjs: the best-known battles, events and
// disasters that happened on each date, and the best-known people born on
// it. The section stays hidden if today's file can't be loaded.
(function () {
  "use strict";
  var section = document.querySelector("[data-on-this-day]");
  if (!section || !window.fetch) return;

  var now = new Date();
  var pad = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  var day = pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  var dateLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric" });

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }
  // Wikipedia opens in a new tab, so the map (on the homepage) stays put.
  function link(href, text, external) {
    var a = el("a", "", text);
    a.href = href;
    if (external) {
      a.target = "_blank";
      a.rel = "noopener";
    }
    return a;
  }
  function entry(when, name, wiki, where, desc) {
    var li = el("li");
    li.appendChild(el("span", "when", when || "—"));
    var what = el("span", "what");
    what.appendChild(wiki ? link(wiki, name, true) : document.createTextNode(name));
    if (where) {
      what.appendChild(document.createTextNode(" "));
      what.appendChild(where);
    }
    if (desc) what.appendChild(el("span", "desc", desc));
    li.appendChild(what);
    return li;
  }

  function render(data) {
    var events = (data && data.events) || [];
    var born = (data && data.born) || [];
    if (!events.length && !born.length) return;

    var title = section.querySelector("[data-otd-title]");
    if (title) title.textContent = "On this day: " + dateLabel;

    var eventsList = section.querySelector("[data-otd-events]");
    events.forEach(function (e) {
      var where = el("span", "where");
      if (e.page) {
        where.appendChild(document.createTextNode("near "));
        where.appendChild(link("/places/" + e.page.slug, e.page.name));
      } else {
        where.appendChild(link(e.map, "on the map"));
      }
      eventsList.appendChild(entry(e.year, e.name, e.wiki, where, e.desc));
    });

    var bornList = section.querySelector("[data-otd-born]");
    var bornTitle = section.querySelector("[data-otd-born-title]");
    if (bornList && born.length) {
      born.forEach(function (p) {
        var life = p.born ? p.born + (p.died ? "–" + p.died : "") : "";
        var where = p.place ? el("span", "where", "born in " + p.place) : null;
        bornList.appendChild(entry(life, p.name, p.wiki, where, p.desc));
      });
      bornList.hidden = false;
      if (bornTitle) bornTitle.hidden = false;
    }
    section.hidden = false;
  }

  fetch("/data/onthisday/" + day + ".json")
    .then(function (res) {
      if (!res.ok) throw new Error("On this day: " + res.status);
      return res.json();
    })
    .then(render)
    .catch(function () {});
})();

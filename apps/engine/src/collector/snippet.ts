/**
 * `p.js`, served by the collector (SPEC §5.2 "Snippet"). No cookies, no localStorage, no
 * fingerprinting: it sends the page path (no query string), the external referrer without
 * its query, and UTM parameters, as a `text/plain` POST with `credentials: 'omit'` (a simple
 * request, so no CORS preflight). It stays silent when the browser sends Global Privacy
 * Control or Do Not Track. `window.leIdentify(email)` sends only the email's domain.
 */
export const SNIPPET_JS = `/* Lead Engine: company-level analytics. No cookies, no storage. */
(function () {
  var s = document.currentScript;
  if (!s || window.__le) return;
  window.__le = 1;
  var key = s.getAttribute('data-site');
  var base = s.src.replace(/\\/p\\.js(\\?.*)?$/, '');
  var nav = navigator;
  var off = nav.globalPrivacyControl === true || nav.doNotTrack === '1' || window.doNotTrack === '1';
  function send(path, body) {
    if (off || !key) return;
    try {
      fetch(base + path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'omit',
        mode: 'no-cors',
        keepalive: true
      });
    } catch (e) {}
  }
  function clip(v, n) { return v ? String(v).slice(0, n) : undefined; }
  var last = '';
  function view() {
    var path = location.pathname;
    if (path === last) return;
    last = path;
    var ref, utm = {}, any = false;
    try {
      if (document.referrer) {
        var r = new URL(document.referrer);
        if (r.host !== location.host) ref = r.origin + r.pathname;
      }
      var q = new URLSearchParams(location.search);
      ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (k) {
        var v = q.get('utm_' + k);
        if (v) { utm[k] = clip(v, 128); any = true; }
      });
    } catch (e) {}
    send('/collect/v', { siteKey: key, path: clip(path, 512), referrer: clip(ref, 512), utm: any ? utm : undefined });
  }
  var push = history.pushState;
  history.pushState = function () { var r = push.apply(this, arguments); setTimeout(view, 0); return r; };
  addEventListener('popstate', function () { setTimeout(view, 0); });
  window.leIdentify = function (email) {
    var d = String(email || '').split('@')[1];
    if (d) send('/collect/identify', { siteKey: key, emailDomain: d.trim().toLowerCase().slice(0, 253) });
  };
  view();
})();
`;

/** A transparent 1×1 GIF for the `<noscript>` pixel. */
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/** The two lines a site owner pastes before `</body>`. */
export function snippetHtml(collectorUrl: string, siteKey: string): string {
  const base = collectorUrl.replace(/\/+$/, '');
  return [
    `<script async src="${base}/p.js" data-site="${siteKey}"></script>`,
    `<noscript><img src="${base}/collect/v.gif?s=${siteKey}" alt="" width="1" height="1" style="position:absolute;left:-9999px" referrerpolicy="strict-origin-when-cross-origin"></noscript>`,
  ].join('\n');
}

# Privacy policy text for sites running the Lead Engine snippet

Paste the paragraph below into the privacy policy of every site that runs the snippet (SPEC §9). Replace the bracketed parts. It covers what the snippet does, the CCPA/CPRA disclosure, and how to opt out. It's a starting point written from how the code behaves, not legal advice; have your lawyer check it against your full policy.

---

### Company-level website analytics

We use Lead Engine, a self-hosted analytics tool, to learn which **companies** visit our website. We don't use it to identify individual people.

**What is collected.** When you load a page, a small script sends us the page path (without the query string), the website that referred you (without its query string), any campaign (UTM) parameters in the link, and, as part of every web request, your IP address and browser user agent. If you submit a form on our site, the script may also send the **domain** of the email address you entered (for example `example.com`), never the full address.

**How it is used.** Your IP address is used, in memory, to look up whether it belongs to a business network in the United States and, if so, which company it is registered to. For that lookup we use a local IP database (DB-IP or IPinfo) and the IP lookup service ipapi.is. Visits from outside the United States, from consumer internet providers, mobile networks, VPNs, hosting providers and automated bots are discarded at once; for those we keep only aggregate daily counts. For visits from a company network we store the company, the pages viewed and the time, linked to a daily pseudonymous session identifier that can't be traced back to you and changes every day.

**What we don't do.** The script sets no cookies, uses no local storage or similar technologies, doesn't fingerprint your device, doesn't record your screen or keystrokes, and doesn't identify you by name. It sends nothing at all if your browser signals Global Privacy Control or Do Not Track.

**Retention.** IP lookup results are kept for at most 30 days. Company network ranges learned from form submissions are kept for 90 days. Company-level visit records are kept as part of our business records [for as long as the business relationship is relevant / for N months].

**Your California privacy rights (CCPA/CPRA).** In the preceding 12 months we collected *identifiers* (IP address) and *internet or other electronic network activity information* (pages viewed, referring site) for the business purposes of analytics and identifying businesses interested in our services. We don't sell this information, and we don't share it for cross-context behavioural advertising. We honour Global Privacy Control signals as a request to opt out. You have the right to know, delete and correct personal information we hold about you, and not to be discriminated against for exercising these rights. To make a request, email [privacy@yourdomain.com] or write to [company name, postal address]. We respond within the time the law requires.

**Opt out.** You can opt out by enabling Global Privacy Control or Do Not Track in your browser, by blocking scripts from `[collect.yourdomain.com]`, or by emailing [privacy@yourdomain.com] to have your company's domain added to our suppression list.

IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0). [If you set `LE_IPINFO_TOKEN`: IP address data is powered by [IPinfo](https://ipinfo.io).]

---

## Notes for the site owner

- **Where to put the snippet.** Before `</body>` on every page. Settings → Sites & snippet shows the exact two lines for each site, with a copy button and an install check.
- **Form identification.** Call `window.leIdentify(email)` from your form's submit handler in the browser (not from your server: the collector maps the visitor's own IP). Only the email's domain is sent. Free-mail domains (Gmail, Outlook, Yahoo, …) and visitors on consumer, mobile, hosting or VPN networks are ignored.
- **Consent banners.** The snippet sets no cookies and stores nothing on the device, so it doesn't need cookie consent under US law. If your site also serves visitors in the EU or UK, the collector drops their visits before anything is stored, but the request still reaches it; if your banner blocks all third-party scripts until consent, load the snippet the same way.
- **California wiretap claims (CIPA).** These suits target session replay, chat recording and person-level pixels. The snippet records no content of communications (no form fields, keystrokes or screen) and identifies no individuals, which keeps this risk low; it is still why the disclosure above should be in place before you install it.
- **Opt-out requests** by email: add the person's email or company domain under Suppression. Suppressed domains are dropped by the collector and hidden everywhere else (SPEC §9, honoured within 10 business days).

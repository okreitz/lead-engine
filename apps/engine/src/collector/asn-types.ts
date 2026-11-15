/**
 * Local ASN type hints (SPEC §5.2 step 5, "ASN type from the free ASN database first"). The
 * free DB-IP and IPinfo Lite databases carry an AS number and name but no type, so this is a
 * short hand-checked list of large US networks whose traffic is almost never a company's
 * office: hosting/cloud, mobile carriers and residential ISPs. A hit drops the visit without
 * spending an ipapi.is lookup; anything else goes to ipapi.is.
 *
 * Mixed backbones that also sell business lines with company WHOIS records (Lumen 3356/209,
 * Verizon Business 701, AT&T 7018, Cogent 174, Zayo 6461) are left out on purpose, so their
 * business customers are still classified by ipapi.is. The IpCompany map is checked before
 * this list, so a form fill can still identify a company behind any of these networks.
 * Networks of companies that also browse from their own ASN (Google 15169, Microsoft 8075)
 * are left out too.
 */
export type AsnType = 'hosting' | 'isp' | 'mobile';

const LIST: Record<AsnType, number[]> = {
  hosting: [
    16509,
    14618,
    8987, // Amazon / AWS
    396982, // Google Cloud (not 15169: Google's own offices browse from it)
    14061, // DigitalOcean
    63949, // Akamai Connected Cloud (Linode)
    20473, // Vultr (Choopa)
    24940,
    213230, // Hetzner
    16276, // OVHcloud
    197540, // netcup
    51167, // Contabo
    31898, // Oracle Cloud
    13335,
    209242, // Cloudflare (incl. WARP)
    54113, // Fastly
    20940,
    16625,
    36183, // Akamai (36183: iCloud Private Relay egress)
    36352, // ColoCrossing / HostPapa
    9009, // M247 (VPN hosting)
    212238, // Datacamp / CDN77
    60068, // CDN77
    46606, // Unified Layer / Bluehost
    26496, // GoDaddy
    32244, // Liquid Web
    62567, // DigitalOcean (legacy)
    19318, // Interserver
    8100, // QuadraNet
  ],
  mobile: [
    21928, // T-Mobile USA
    6167,
    22394, // Verizon Wireless (Cellco)
    20057, // AT&T Mobility
    10507, // Sprint (T-Mobile)
  ],
  isp: [
    7922,
    33650,
    33651,
    33652,
    33657,
    33659,
    33660,
    33662,
    33667,
    33668, // Comcast Xfinity
    20115,
    11351,
    11426,
    10796,
    12271,
    33363,
    7843,
    11427,
    20001, // Charter Spectrum
    22773, // Cox
    5650, // Frontier
    6128, // Optimum (Cablevision)
    19108, // Suddenlink
    30036, // Mediacom
    11492, // Cable One / Sparklight
    12083, // WideOpenWest
    14593, // Starlink
    6389, // AT&T residential (BellSouth.net)
    7155, // Viasat
    6621, // HughesNet
  ],
};

const BY_ASN = new Map<number, AsnType>();
for (const [type, list] of Object.entries(LIST) as [AsnType, number[]][]) {
  for (const asn of list) BY_ASN.set(asn, type);
}

export function localAsnType(asn: number | null | undefined): AsnType | null {
  return asn ? (BY_ASN.get(asn) ?? null) : null;
}

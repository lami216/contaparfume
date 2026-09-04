export const LICENSE_KEY_ID = "alkarna-license-v1" as const;
export const LICENSE_V2_KEY_ID = "alkarna-license-v2" as const;
export const LICENSE_ALGORITHM = "ECDSA_P256_SHA256" as const;

export const PUBLIC_LICENSE_KEYS = {
  [LICENSE_KEY_ID]: {
    kty: "EC",
    crv: "P-256",
    x: "VafWOl9h-bF8auIQTUvS5AATeR8yyxJu49p-QSzk7-s",
    y: "Pz7QrSsgtgcKhvc_eSblH0BPcBwEo9lCo-0zkXwIDzM",
    ext: true,
    key_ops: ["verify"],
  },
  [LICENSE_V2_KEY_ID]: {
    kty: "EC", crv: "P-256",
    x: "-kAStxv0yNuJ9GyzSNaiywfrZ5BziSWL5kJVMFOnRUY",
    y: "AburlAjGDOBSzFeNa2sxyd4XgLM5CWKuDR4Hpe57GYU",
    ext: true, key_ops: ["verify"],
  },
} as const;

"""Vendored CA intermediates for the Comex Stat hosts.

MDIC's file host serves only its leaf certificate and omits the issuing
intermediate, so Python's certifi-based verification fails with "unable to get
local issuer certificate" — even though the *root* is trusted. curl/Secure
Transport works because it fetches the intermediate via AIA; ``requests`` does
not.

We embed the intermediates (**public** CA certificates, not private keys) and
append them to certifi's bundle at runtime so verification succeeds
deterministically on every platform — macOS dev, Linux CI, Cloud Run —
**without disabling TLS verification**.

Two hosts, two issuers, because MDIC moved the files (measured 2026-10-21):

1. ``balanca.economia.gov.br`` — the legacy host, Sectigo-issued. Its leaf
   certificate (``*.economia.gov.br``) EXPIRED, so no bundle can verify it any
   more; the vendored Sectigo certificate is kept for as long as the host still
   answers, because the raw archive and old runs reference it.
2. ``balanca.mdic.gov.br`` — the current host (the default since this change),
   issued by SERPRO. It too presents only the leaf.

Sectigo:

- subject: CN=Sectigo Public Server Authentication CA OV R36
- issuer:  CN=Sectigo Public Server Authentication Root R46  (in certifi)
- source:  http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt
- expires: 2036-03-21 — re-vendor if the host rotates its issuing CA.

SERPRO:

- subject: CN=AC SERPRO AR46 OV TLS CA 2025
- issuer:  CN=GlobalSign Root R46  (in certifi)
- source:  http://secure.globalsign.com/cacert/acserproar46ovtlsca2025.crt (the
  leaf's AIA — fetched over plain http, so its authenticity rests on the two
  signature checks, not on the transport: the leaf verifies against it and it
  verifies against a root already in certifi)
- sha256:  F2:70:95:D0:B4:0D:F7:65:59:94:04:01:1C:F8:B1:67:DA:06:26:0E:81:DD:A7:27:
           F1:63:EF:08:22:10:71:E4  (pinned in tests/test_comex_client.py)
- expires: 2030-10-15 — re-vendor if the host rotates its issuing CA.

The new host's LEAF is short-lived: the ``*.mdic.gov.br`` certificate measured
on 2026-10-21 expires on 2026-10-22, and its renewal will present a new leaf.
That needs no change here as long as the same SERPRO intermediate issues it —
which is exactly the failure to watch for: a different issuer would reproduce
"unable to get local issuer certificate" and need a new vendored certificate.
"""

# Public CA certificate (PEM). Not a secret. pragma: allowlist secret
SECTIGO_INTERMEDIATE_PEM = """\
-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQLBo8dulD3d3/GRsxiQrtcTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgT1YgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEApkMtJ3R06jo0fceI0M52B7K+TyMeGcv2BQ5AVc3j
lYt76TvHIu/nNe22W/RJXX9rWUD/2GE6GF5x0V4bsY7K3IeJ8E7+KzG/TGboySfD
u+F52jqQBbY62ofhYjMeiAbLI02+FqwHeM8uIrUtcX8b2RCxF358TB0NHVccAXZc
FYgZndZCeXxjuca7pJJ20LLUnXtgXcjAE1vY4WvbReW0W6mkeZyNGdmpTcFs5Y+s
yy6LtE5Zocji9J9NlNnReox2RWVyEXpA1ChZ4gqN+ZpVSIQ0HBorVFbBKyhdZyEX
gZgNSNtBRwxqwIzJePJhYd4ZUhO1vk+/uP3nwDk0p95q/j7naXNCSvESnrHPypaB
WRK066nKfPRPi9m9kIOhMdYfS8giFRTcdgL24Ycilj7ecAK9Trh0VbjwouJ4WH+x
bt47u68ZFCD/ac55I0DNHkCpaPruj6e9Rmr7K46wZDAYXuEAqB7tGG/jd6JAA+H2
O44CV98NRsU213f1kScIZntNAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQU42Z0u3BojSxdTg6mSo+bNyKcgpIw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgIw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
BZXWDHWC3cubb/e1I1kzi8lPFiK/ZUoH09ufmVOrc5ObYH/XKkWUexSPqRkwKFKr
7r8OuG+p7VNB8rifX6uopqKAgsvZtZsq7iAFw04To6vNcxeBt1Eush3cQ4b8nbQR
MQLChgEAqwhuXp9P48T4QEBSksYav7+aFjNySsLYlPzNqVM3RNwvBdvp6vgDtGwc
xlKQZVuuNVIaoYyls8swhxDeSHKpRdxRauTLZ+pl+wGvy0pnrLEJGSz9mOEmfbod
e/XopR2NGqaHJ6bIjyxPu6UtyQGI26En7UAEozACrHz06Nx2jTAY9E6NeB6XuobE
wLK025ZRmvglcURG1BrV24tGHHTgxCe8M3oGlpUSMTKQ2dkgljZVYt+gKdFtWELZ
MuRdi+X3XsrR8LFz+aLUiDRfQqhmw3RxjIyVKvvu9UPYY1nsvxYmFnUSeM+2q1z/
iPUry+xDY9MC6+IhleKT094VKdFVp7LXH42+wvU+17lRolQ2mK2N/nBLVBwaIhib
QXw4VYKwB86Bc6eS6iqsc94KEgD/U4VsjmgfhK+Xp4NM+VYzTTa3QeV3p8xOM0cw
q1p8oZFA+OBcz3FYWpDIe5j0NWKlw9hXsTyPY/HeZUV59akskSOSRSmDfe8wJDPX
58uB9/7lud0G3x0pxQAcffP0ayKavNwDTw4UfJ34cEw=
-----END CERTIFICATE-----
"""

# Public CA certificate (PEM). Not a secret. pragma: allowlist secret
SERPRO_INTERMEDIATE_PEM = """\
-----BEGIN CERTIFICATE-----
MIIFpzCCA4+gAwIBAgIRAIRx9G2LfAoKwTKl53hyfAswDQYJKoZIhvcNAQELBQAw
RjELMAkGA1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExHDAaBgNV
BAMTE0dsb2JhbFNpZ24gUm9vdCBSNDYwHhcNMjUxMDE1MDMxMDI1WhcNMzAxMDE1
MDAwMDAwWjByMQswCQYDVQQGEwJCUjE7MDkGA1UEChMyU0VSVklDTyBGRURFUkFM
IERFIFBST0NFU1NBTUVOVE8gREUgREFET1MgKFNFUlBSTykxJjAkBgNVBAMTHUFD
IFNFUlBSTyBBUjQ2IE9WIFRMUyBDQSAyMDI1MIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAyMRQ+shSUPjCphR87q8phTDqKNHDF4vPorY+Fyj6LQw75f6Z
cv1sGTbeqfNlrvh9hj1ealgKX/EfBnOVUzFzT0r0SoiLrXL7aun+qnIie7jpaTRd
BuvzSvjfYFVuHs9z+s2iTytmKb1AqJ3NhOvSnrrO6Bz/0ofBjaiwahAQip7SVpdA
LuZOIckg1cW9tHjJTrJKcgsk6IBSLiCI38Wq7G3v5umngmAzCCUadC3ZMz8e7sHj
I7GEo/AKG5SPHysNL44SEhzTLU+aywXMQ+n/g4+71KMbJyKoAeHHx0bv1AjLj3QS
YeG/3caYWlKVLjt7sl882Z7wY9vmlsYcH82jxQIDAQABo4IBYjCCAV4wDgYDVR0P
AQH/BAQDAgGGMBMGA1UdJQQMMAoGCCsGAQUFBwMBMBIGA1UdEwEB/wQIMAYBAf8C
AQAwHQYDVR0OBBYEFEFQmVF44XVOwf9nFeEu0LIj1D2GMB8GA1UdIwQYMBaAFANc
q3OBh6jMsKbVlOI2lkn/BZksMHsGCCsGAQUFBwEBBG8wbTAuBggrBgEFBQcwAYYi
aHR0cDovL29jc3AuZ2xvYmFsc2lnbi5jb20vcm9vdHI0NjA7BggrBgEFBQcwAoYv
aHR0cDovL3NlY3VyZS5nbG9iYWxzaWduLmNvbS9jYWNlcnQvcm9vdHI0Ni5jcnQw
NgYDVR0fBC8wLTAroCmgJ4YlaHR0cDovL2NybC5nbG9iYWxzaWduLmNvbS9yb290
cjQ2LmNybDAuBgNVHSAEJzAlMAgGBmeBDAECAjAMBgorBgEEAaAyCgECMAsGCSsG
AQQBoDIBFDANBgkqhkiG9w0BAQsFAAOCAgEAMuKjBsN1ZzTAC+2mPeg0WHz24WGF
zmR4YZgNAdniTXKZXlCwB7Sdgfx/O7nM0dDKJXvDSHM4U7A7ZIm9Kii1kDAIsi9P
UQg0uSX002FHw+6//EWxAjYp2SealDrNewpu31SWBwuY6cqwbrlIRaO5meyQL+iN
ZxNfQX7Xz2q2LJqbn5KXIaYXyUy8QGXWSJR4ezZUMFQK6MY48h8IFjxjh709yQiQ
wm6UH9pR+uCllCD0yF5GvbaII1MVp3BYud99IOu0Pcl1UPxtDsLPNy6gndm9gwDS
imc3lE6kzLdVdlDyVM/d5yY5g16OLMgAqdT0NH2rZMviIsanM3Wj8QDx2QFwoa5+
eN4gc1gCT45oiSzX4yHs61Hve+X9pArxv131lsIg5ycS+MGfF2d9PihcrJxUx0s/
dk+5Y1b9LUdDQm9VRFhaU3fhCxoTpchNZhPJpVecP7wuc+7DaphfI/y5UIKOh4dr
NpUPEy65MXw9zz/DOrFK1s4d9iz6Zk9oriZkeQq6Hzs3rQ5IZ4xWSBE6eZXYmuJF
octVsACXaDuOPSWmSAWnZQWRR/8r6lettq614jWzhFTVtV9lPCcY47r3+owtYqDG
V4NDxqRf0TrkkbR2kiPh4x1cdM9sjQukc3CkTThHXHQCP9TULHO2cgz2Oys2kBav
BheS1LHxSa8rZ7o=
-----END CERTIFICATE-----
"""

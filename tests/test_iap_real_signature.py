"""The IAP assertion check, run for real — no mock of google-auth.

Every other IAP test mocks ``id_token.verify_token``, so the signature check that decides
who authored a curation edit never touches the crypto stack it depends on
(google-auth -> google.auth.crypt.es256 -> cryptography). A bump of either library could
change that behaviour and the suite would stay green: exactly the situation v1.88.2 created
(cryptography 49 -> 50, pyasn1 0.6.3 -> 0.6.4), which was checked by hand, once.

Here the production function verifies ES256 tokens against a local server that publishes
the key in IAP's own format (``{kid: SPKI PEM}``, as
https://www.gstatic.com/iap/verify/public_key serves it). Offline and deterministic: the
key is generated per module, the server binds an ephemeral port on 127.0.0.1.
"""

from __future__ import annotations

import http.server
import json
import threading
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from google.auth import crypt, jwt

from embrapa_dashboard.serving import iap

KID = "test-kid"
AUDIENCE = "/projects/123/locations/us-central1/services/embrapa-dashboard"
EMAIL = "pesquisador@embrapa.br"


def _es256_pair() -> tuple[bytes, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return private_pem, public_pem.decode()


SIGNING_KEY, PUBLIC_KEY = _es256_pair()
FOREIGN_KEY, _ = _es256_pair()


@pytest.fixture(scope="module")
def certs_url():
    body = json.dumps({KID: PUBLIC_KEY}).encode()

    class Certs(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Certs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/public_key"
    server.shutdown()
    server.server_close()  # shutdown() only stops the loop; this releases the socket


@pytest.fixture(autouse=True)
def _no_proxy_for_loopback(monkeypatch):
    # A developer or CI proxy must not intercept the loopback cert server.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")


def _token(key: bytes = SIGNING_KEY, **overrides) -> str:
    now = int(time.time())
    claims = {
        "iss": iap.IAP_ISSUER,
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + 300,
        "email": EMAIL,
    }
    claims.update(overrides)
    return jwt.encode(crypt.ES256Signer.from_string(key, key_id=KID), claims).decode()


def _verify(token: str, certs_url: str) -> str:
    return iap.verify_iap_jwt({iap.IAP_JWT_HEADER: token}, audience=AUDIENCE, certs_url=certs_url)


def test_a_genuine_iap_token_verifies_to_its_email(certs_url):
    assert _verify(_token(), certs_url) == EMAIL


def _tampered() -> str:
    token = _token()
    head, payload, signature = token.split(".")
    swapped = "A" if signature[10] != "A" else "B"
    return ".".join((head, payload, signature[:10] + swapped + signature[11:]))


@pytest.mark.parametrize(
    ("case", "make_token"),
    [
        ("tampered signature", _tampered),
        ("signed by another key under the same kid", lambda: _token(key=FOREIGN_KEY)),
        ("expired", lambda: _token(iat=int(time.time()) - 7200, exp=int(time.time()) - 3600)),
        ("wrong audience", lambda: _token(aud="/projects/999/global/backendServices/1")),
        # Validly signed, but minted for another Google product: verify_token does not
        # check the issuer, verify_iap_jwt must.
        ("wrong issuer", lambda: _token(iss="https://accounts.google.com")),
    ],
)
def test_every_forged_or_stale_token_is_refused(certs_url, case, make_token):
    with pytest.raises(iap.InvalidIapAssertionError):
        _verify(make_token(), certs_url)

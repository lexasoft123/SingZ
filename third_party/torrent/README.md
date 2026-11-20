# Torrent HTTPS trust roots

Mozilla CA certificates converted by curl, snapshot 2026-10-20.

Source: https://curl.se/ca/cacert-2026-10-20.pem
SHA-256: 796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe
License: Mozilla Public License 2.0, https://www.mozilla.org/en-US/MPL/2.0/

The PEM bytes are unmodified. The source and conversion details are in the
bundle header. The libtorrent vendor script compiles these trust anchors into
its HTTPS client while retaining certificate and hostname verification.
This avoids relying on OpenSSL installation paths that do not exist on phones.
Update this pinned snapshot deliberately when updating the torrent SDK.

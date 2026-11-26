// Sub-Store script operation: remove TLS certificate_sha256 for sing-box < 1.15.
// Place this AFTER the sing-box template.js operation.

const config = typeof $content === 'string' ? JSON.parse($content) : $content

let removed = 0
for (const outbound of config.outbounds ?? []) {
  if (outbound?.tls && 'certificate_sha256' in outbound.tls) {
    delete outbound.tls.certificate_sha256
    removed++
  }
}
for (const endpoint of config.endpoints ?? []) {
  if (endpoint?.tls && 'certificate_sha256' in endpoint.tls) {
    delete endpoint.tls.certificate_sha256
    removed++
  }
}

console.log(`[strip-certificate-sha256] removed ${removed} field(s)`)
$content = JSON.stringify(config, null, 2)

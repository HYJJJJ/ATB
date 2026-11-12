const { X509Certificate } = require('node:crypto');
const { isIP } = require('node:net');

function isTrustedUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}

function certificateMatches(certificate, caPem, hostname) {
  try {
    const leaf = new X509Certificate(certificate);
    const root = new X509Certificate(caPem);
    const now = Date.now();
    for (const cert of [leaf, root]) {
      if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) return false;
    }
    if (!root.ca || leaf.ca || !root.verify(root.publicKey) || !leaf.checkIssued(root) || !leaf.verify(root.publicKey)) return false;
    if (leaf.keyUsage && !leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1')) return false;
    return Boolean(isIP(hostname) ? leaf.checkIP(hostname) : leaf.checkHost(hostname, { wildcards: false, subject: 'never' }));
  } catch { return false; }
}

module.exports = { certificateMatches, isTrustedUrl };

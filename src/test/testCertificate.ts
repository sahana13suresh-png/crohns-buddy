/**
 * Test-only X.509 certificate minting.
 *
 * `joseAuthTokenVerifier` resolves signing keys with `importX509`, so a test
 * that exercises real RS256 signature verification needs the mocked certificate
 * endpoint to serve a real certificate PEM — not a bare public key. Node can
 * generate the key pair but not wrap it in a certificate, so this module emits
 * a minimal X.509 v1 certificate (empty extension set, self-signed) whose
 * SubjectPublicKeyInfo is the generated public key. That is all the verifier
 * reads out of it, and it keeps the signature path in the tests genuine rather
 * than mocked.
 *
 * Keys are generated per call and never written to disk.
 */

import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_UTF8_STRING = 0x0c;
const TAG_UTC_TIME = 0x17;
const TAG_SEQUENCE = 0x30;
const TAG_SET = 0x31;

/** DER definite-length encoding, short form under 128 bytes, long form above. */
function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);

  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER tag-length-value triple. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

/** `sha256WithRSAEncryption` (1.2.840.113549.1.1.11) with its NULL parameters. */
const SHA256_RSA_ALGORITHM = tlv(
  TAG_SEQUENCE,
  Buffer.concat([
    tlv(TAG_OID, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    tlv(TAG_NULL, Buffer.alloc(0)),
  ]),
);

/** A single-attribute Name: `CN=<commonName>`. */
function distinguishedName(commonName: string): Buffer {
  const attribute = tlv(
    TAG_SEQUENCE,
    Buffer.concat([
      tlv(TAG_OID, Buffer.from([0x55, 0x04, 0x03])), // id-at-commonName
      tlv(TAG_UTF8_STRING, Buffer.from(commonName, 'utf8')),
    ]),
  );
  return tlv(TAG_SEQUENCE, tlv(TAG_SET, attribute));
}

/** `Validity`, fixed well outside any window a test would exercise. */
function validity(): Buffer {
  return tlv(
    TAG_SEQUENCE,
    Buffer.concat([
      tlv(TAG_UTC_TIME, Buffer.from('200101000000Z', 'ascii')),
      tlv(TAG_UTC_TIME, Buffer.from('491231235959Z', 'ascii')),
    ]),
  );
}

function toPem(der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export interface TestSigningKeyPair {
  /** Signs test Auth_Tokens. */
  privateKey: KeyObject;
  /** The `kid` under which {@link certificatePem} is published. */
  kid: string;
  /** X.509 certificate PEM, in the shape Google's endpoint serves. */
  certificatePem: string;
}

/**
 * Generates an RSA key pair and a self-signed certificate carrying its public
 * key, published under `kid`.
 */
export function createTestSigningKeyPair(kid: string): TestSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const tbsCertificate = tlv(
    TAG_SEQUENCE,
    Buffer.concat([
      tlv(TAG_INTEGER, Buffer.from([0x01])), // serialNumber
      SHA256_RSA_ALGORITHM,
      distinguishedName(`crohns-buddy-test-${kid}`), // issuer
      validity(),
      distinguishedName(`crohns-buddy-test-${kid}`), // subject
      publicKey.export({ type: 'spki', format: 'der' }),
    ]),
  );

  const signature = signBytes('sha256', tbsCertificate, privateKey);

  const certificate = tlv(
    TAG_SEQUENCE,
    Buffer.concat([
      tbsCertificate,
      SHA256_RSA_ALGORITHM,
      tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([0x00]), signature])),
    ]),
  );

  return { privateKey, kid, certificatePem: toPem(certificate) };
}

import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SHA256, listedObjects, signRequest } from "../s3-sigv4.mjs";

// AWS's published S3 SigV4 example ("GET Object", Signature Calculations for
// the Authorization Header): the same inputs must give the same signature.
test("signs AWS's published GET Object example to the published signature", () => {
  const headers = signRequest({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    payloadHash: EMPTY_SHA256, headers: { range: "bytes=0-9" }, now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("signs AWS's published ListObjects example (query parameters sorted and encoded)", () => {
  const headers = signRequest({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(headers.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
});

test("a listing is read for keys, dates and sizes", () => {
  const xml = `<ListBucketResult><Contents><Key>infra-cod/a.gpg</Key><LastModified>2026-10-07T03:00:00.000Z</LastModified><Size>120</Size></Contents>
    <Contents><Key>infra-cod/b&amp;c.gpg</Key><LastModified>2026-10-08T03:00:00.000Z</LastModified><Size>7</Size></Contents></ListBucketResult>`;
  assert.deepEqual(listedObjects(xml), [
    { key: "infra-cod/a.gpg", lastModified: "2026-10-07T03:00:00.000Z", size: 120 },
    { key: "infra-cod/b&c.gpg", lastModified: "2026-10-08T03:00:00.000Z", size: 7 },
  ]);
});
